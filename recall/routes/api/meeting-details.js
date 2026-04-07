import db from "../../db.js";
import { backgroundQueue } from "../../queue.js";
import { findAccessibleArtifact } from "../../services/meetings/access.js";
import { effectiveSuperAgentChapters, isSuperAgentEnabled } from "../../utils/super-agent.js";
import Recall from "../../services/recall/index.js";
import { Op } from "sequelize";

// Generic/placeholder titles we should ignore when deriving a display name
function isGenericMeetingTitle(title) {
  if (!title) return true;
  const normalized = String(title).trim().toLowerCase();
  return (
    normalized === "meeting" ||
    normalized === "untitled meeting" ||
    normalized === "untitled" ||
    normalized === "(no title)" ||
    // "Meeting on 2/6/2026" - date-based fallback; prefer extracting from rawPayload (meeting_title, etc.)
    /^meeting on \d/.test(normalized)
  );
}

/**
 * Get participants from artifact rawPayload
 */
function getParticipantsFromArtifact(artifact) {
  const data = artifact?.rawPayload?.data || {};
  const participants = data.participants || data.attendees || [];
  if (!Array.isArray(participants)) return [];
  return participants
    .map((p) => {
      if (!p) return null;
      return {
        email: p.email || p.address || p.user_email || p.userId || null,
        name: p.name || p.displayName || p.user_display_name || p.user_name || p.email || null,
      };
    })
    .filter(Boolean);
}

/**
 * Try to identify meeting platform from URL.
 */
function extractTitleFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const host = urlObj.hostname.toLowerCase();
    if (host.includes("zoom.us")) return "Zoom Meeting";
    if (host.includes("meet.google.com")) return "Google Meet";
    if (host.includes("teams.microsoft.com")) return "Microsoft Teams Meeting";
    if (host.includes("webex.com")) return "Webex Meeting";
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Derive a human-readable meeting title from various sources.
 */
function extractMeetingTitle(artifact, calendarEvent) {
  // 1) Calendar event title (virtual field that gets summary/subject from raw data)
  if (calendarEvent?.title && !isGenericMeetingTitle(calendarEvent.title)) {
    return calendarEvent.title;
  }

  // 2) Calendar event recallData title fields
  const calEventTitle = calendarEvent?.recallData?.meeting_title || calendarEvent?.recallData?.title;
  if (calEventTitle && !isGenericMeetingTitle(calEventTitle)) {
    return calEventTitle;
  }

  // 3) Artifact payload title
  if (artifact?.rawPayload?.data?.title && !isGenericMeetingTitle(artifact.rawPayload.data.title)) {
    return artifact.rawPayload.data.title;
  }

  // 4) Bot meeting_metadata title (if present)
  const botMetaTitle = artifact?.rawPayload?.data?.bot_metadata?.meeting_metadata?.title;
  if (botMetaTitle && !isGenericMeetingTitle(botMetaTitle)) {
    return botMetaTitle;
  }

  // 5) Derive from meeting URL
  const meetingUrl = artifact?.rawPayload?.data?.meeting_url || calendarEvent?.meetingUrl;
  if (meetingUrl) {
    const urlTitle = extractTitleFromUrl(meetingUrl);
    if (urlTitle) return urlTitle;
  }

  // 6) Build from participants
  const participants = getParticipantsFromArtifact(artifact);
  if (participants.length > 0) {
    const names = participants
      .slice(0, 2)
      .map((p) => p.name || p.email?.split("@")[0])
      .filter(Boolean);
    if (names.length > 0) {
      return `Meeting with ${names.join(" and ")}${participants.length > 2 ? ` +${participants.length - 2}` : ""}`;
    }
  }

  // 7) Date-based fallback
  const startTime = calendarEvent?.startTime || artifact?.rawPayload?.data?.start_time || artifact?.createdAt;
  if (startTime) {
    const date = new Date(startTime);
    return `Meeting on ${date.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" })}`;
  }

  return "Untitled Meeting";
}

/**
 * Get meeting metadata (fast, no transcript) for lazy loading
 * GET /api/meetings/:meetingId/metadata
 */
export async function getMeetingMetadata(req, res) {
  if (!req.authenticated) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { meetingId } = req.params;
  const userId = req.authentication.user.id;
  const userEmail = req.authentication.user.email || null;

  try {
    // Find artifact with minimal includes (no transcript chunks)
    let artifact = await db.MeetingArtifact.findOne({
      where: {
        [Op.or]: [
          { id: meetingId },
          { readableId: meetingId },
        ],
      },
      include: [
        {
          model: db.CalendarEvent,
          include: [{ model: db.Calendar }],
        },
        {
          model: db.MeetingSummary,
        },
      ],
    });

    if (!artifact) {
      return res.status(404).json({ error: "Meeting not found" });
    }

    // Check access
    const isOwner = artifact.userId === userId || artifact.ownerUserId === userId;
    let hasAccess = isOwner;
    let shareInfo = null;

    if (!isOwner) {
      const user = await db.User.findByPk(userId);
      const shareWhereClause = {
        meetingArtifactId: artifact.id,
        status: "accepted",
        [Op.or]: [{ sharedWithUserId: userId }],
      };
      if (user?.email) {
        shareWhereClause[Op.or].push({ sharedWithEmail: user.email.toLowerCase() });
      }
      
      shareInfo = await db.MeetingShare.findOne({
        where: shareWhereClause,
        include: [{ model: db.User, as: "sharedByUser", attributes: ["id", "name", "email"] }],
      });
      
      if (shareInfo) {
        hasAccess = true;
      }
    }

    if (!hasAccess) {
      return res.status(403).json({ error: "Access denied" });
    }

    const calendarEvent = artifact.CalendarEvent;
    const summary = artifact.MeetingSummaries?.[0] || null;

    // Resolve calendar for Super Agent: use event's calendar or owner's calendar if no event linked
    let calendarForSuperAgent = calendarEvent?.Calendar || null;
    if (!calendarForSuperAgent) {
      const ownerId = artifact.userId || artifact.ownerUserId;
      if (ownerId) {
        const { sequelize } = db;
        const ownerCalendar = await db.Calendar.findOne({
          where: { userId: ownerId },
          order: [[sequelize.literal('enable_super_agent'), 'DESC'], ['id', 'ASC']],
        });
        calendarForSuperAgent = ownerCalendar || null;
      }
    }

    // Get super agent analysis status
    let superAgentAnalysis = null;
    try {
      superAgentAnalysis = await db.MeetingSuperAgentAnalysis.findOne({
        where: { meetingArtifactId: artifact.id },
        order: [["createdAt", "DESC"]],
        attributes: ["id", "status", "createdAt", "updatedAt"],
      });
    } catch (err) {
      console.warn("[API] MeetingSuperAgentAnalysis lookup failed:", err?.message);
    }

    // Get transcript chunk count (fast query)
    const transcriptCount = await db.MeetingTranscriptChunk.count({
      where: { meetingArtifactId: artifact.id },
    });

    // Build metadata response
    const metadata = {
      id: artifact.id,
      readableId: artifact.readableId,
      title: extractMeetingTitle(artifact, calendarEvent),
      startTime: calendarEvent?.startTime || artifact?.rawPayload?.data?.start_time || artifact?.createdAt,
      endTime: calendarEvent?.endTime || artifact?.rawPayload?.data?.end_time || null,
      status: artifact.status || "completed",
      participants: artifact?.rawPayload?.data?.participants || artifact?.rawPayload?.data?.attendees || [],
      calendarEmail: calendarEvent?.Calendar?.email || null,
      platform: calendarEvent?.platform || null,
      
      // Recording URLs
      videoUrl: 
        artifact?.archivedRecordingUrl ||
        artifact?.rawPayload?.data?.video_url || 
        artifact?.rawPayload?.data?.recording_url || 
        artifact?.rawPayload?.data?.media_shortcuts?.video_mixed?.data?.download_url ||
        artifact?.rawPayload?.data?.media_shortcuts?.video?.data?.download_url ||
        artifact?.sourceRecordingUrl ||
        null,
      audioUrl: 
        artifact?.rawPayload?.data?.audio_url || 
        artifact?.rawPayload?.data?.media_shortcuts?.audio_mixed?.data?.download_url ||
        artifact?.rawPayload?.data?.media_shortcuts?.audio?.data?.download_url ||
        null,
      
      // Flags for lazy loading
      hasSummary: !!summary,
      hasTranscript: transcriptCount > 0,
      transcriptChunkCount: transcriptCount,
      superAgentStatus: superAgentAnalysis?.status || null,
      superAgentProcessingStage: superAgentAnalysis?.processingStage || null,
      superAgentAssemblyTranscriptStatus: superAgentAnalysis?.assemblyTranscriptStatus || null,
      superAgentEnabled: isSuperAgentEnabled(calendarForSuperAgent),
      
      // Ownership
      isOwner,
      isShared: !!shareInfo,
      
      // For enrichment
      artifactId: artifact.id,
      hasBeenEnriched: !!summary,
      
      createdAt: artifact.createdAt,
    };

    return res.json({ metadata });
  } catch (error) {
    console.error(`[API] Error fetching metadata for meeting ${meetingId}:`, error);
    return res.status(500).json({ error: "Failed to fetch meeting metadata" });
  }
}

function normalizeRequestedFeatures(features = {}) {
  if (!features || typeof features !== "object") return {};

  const normalized = {
    translateTo: Array.isArray(features.translateTo)
      ? features.translateTo.filter((lang) => typeof lang === "string" && lang.trim())
      : [],
    topicDetection: !!features.topicDetection,
    contentModeration: !!features.contentModeration,
    piiRedaction: !!features.piiRedaction,
    profanityFiltering: !!features.profanityFiltering,
    sentimentAnalysis: !!features.sentimentAnalysis,
  };

  if (normalized.translateTo.length === 0) {
    delete normalized.translateTo;
  }

  return normalized;
}

/**
 * Get transcript for a meeting
 * GET /api/meetings/:meetingId/transcript
 */
export async function getTranscript(req, res) {
  if (!req.authenticated) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { meetingId } = req.params;
  const userId = req.authentication.user.id;
  const userEmail = req.authentication.user.email || null;

  try {
    // Find the meeting artifact (id or readableId) with access (owner, creator, or accepted share)
    const artifact = await findAccessibleArtifact({
      meetingIdOrReadableId: meetingId,
      userId,
      userEmail,
    });

    if (!artifact) {
      console.log(`[API] Transcript: Meeting ${meetingId} not accessible for user ${userId}`);
      return res.status(404).json({ error: "Meeting not found" });
    }

    console.log(`[API] Transcript: Found artifact ${artifact.id}, recallBotId: ${artifact.recallBotId}`);
    
    // PRIORITY 1: Fetch transcript directly from Recall API if botId is available
    let transcript = [];
    if (artifact.recallBotId) {
      try {
        console.log(`[API] Transcript: Fetching directly from Recall API for bot ${artifact.recallBotId}`);
        const recallTranscript = await Recall.getBotTranscript(artifact.recallBotId);
        
        // #region agent log
        fetch('http://127.0.0.1:7250/ingest/bf0206c3-6e13-4499-92a3-7fb2b7527fcf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-details.js:getTranscript',message:'Recall API transcript response',data:{hasTranscript:!!recallTranscript,transcriptType:Array.isArray(recallTranscript)?'array':typeof recallTranscript,transcriptLength:Array.isArray(recallTranscript)?recallTranscript.length:0,firstItemSample:Array.isArray(recallTranscript)&&recallTranscript[0]?JSON.stringify(recallTranscript[0]).substring(0,500):null,hasParticipant:Array.isArray(recallTranscript)&&recallTranscript[0]?.participant,hasWords:Array.isArray(recallTranscript)&&recallTranscript[0]?.words},timestamp:Date.now(),sessionId:'debug-session',runId:'transcript-debug',hypothesisId:'H1'})}).catch(()=>{});
        // #endregion
        
        if (recallTranscript) {
          console.log(`[API] Transcript: Received transcript from Recall API, type: ${Array.isArray(recallTranscript) ? 'array' : typeof recallTranscript}`);
          
          // Handle different Recall API transcript formats
          if (Array.isArray(recallTranscript)) {
            // Check if it's segments with participant/words format
            const firstItem = recallTranscript[0];
            if (firstItem?.participant && firstItem?.words) {
              // Recall.ai segment format: { participant: { id, name }, words: [{ word, start_timestamp, end_timestamp }] }
              transcript = recallTranscript.flatMap((segment) => {
                const speakerName = segment.participant?.name || `Speaker ${segment.participant?.id || ''}`;
                if (Array.isArray(segment.words) && segment.words.length > 0) {
                  // Group words into chunks for readability
                  const text = segment.words.map(w => w.word || w.text || '').join(' ').trim();
                  const startTime = segment.words[0]?.start_timestamp || segment.words[0]?.start_time || 0;
                  return [{
                    speaker: speakerName,
                    text: text,
                    startTimeMs: startTime,
                    timestamp: startTime,
                    isFinal: true,
                  }];
                }
                return [];
              });
            } else {
              // Direct array format
              transcript = recallTranscript.map((segment) => ({
                speaker: segment.speaker || segment.participant?.name || segment.speaker_id || "Speaker",
                text: segment.text || segment.word || segment.transcript || "",
                startTimeMs: segment.start_timestamp || segment.start_time || segment.timestamp || 0,
                timestamp: segment.start_timestamp || segment.start_time || segment.timestamp || 0,
                isFinal: true,
              }));
            }
          } else if (recallTranscript.words && Array.isArray(recallTranscript.words)) {
            // Object with words array
            transcript = recallTranscript.words.map(word => ({
              speaker: word.speaker || word.speaker_id || "Speaker",
              text: word.word || word.text || "",
              startTimeMs: word.start_timestamp || word.start_time || 0,
              timestamp: word.start_timestamp || word.start_time || 0,
              isFinal: true,
            }));
          } else if (recallTranscript.results && Array.isArray(recallTranscript.results)) {
            // Object with results array
            transcript = recallTranscript.results.map(result => ({
              speaker: result.speaker || result.speaker_id || "Speaker",
              text: result.text || result.transcript || "",
              startTimeMs: result.start_timestamp || result.start_time || 0,
              timestamp: result.start_timestamp || result.start_time || 0,
              isFinal: true,
            }));
          } else if (recallTranscript.text) {
            // Plain text format - split into chunks
            transcript = [{
              speaker: "Speaker",
              text: recallTranscript.text,
              startTimeMs: 0,
              timestamp: 0,
              isFinal: true,
            }];
          }
          
          if (transcript.length > 0) {
            console.log(`[API] Transcript: Successfully parsed ${transcript.length} segments from Recall API`);
            // #region agent log
            fetch('http://127.0.0.1:7250/ingest/bf0206c3-6e13-4499-92a3-7fb2b7527fcf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-details.js:afterParsing',message:'Parsed transcript segments',data:{segmentCount:transcript.length,firstSegment:transcript[0]?{speaker:transcript[0].speaker,textLength:transcript[0].text?.length,textPreview:transcript[0].text?.substring(0,200)}:null,lastSegment:transcript[transcript.length-1]?{speaker:transcript[transcript.length-1].speaker,textLength:transcript[transcript.length-1].text?.length}:null},timestamp:Date.now(),sessionId:'debug-session',runId:'transcript-debug',hypothesisId:'H1'})}).catch(()=>{});
            // #endregion
          }
        }
      } catch (recallError) {
        console.warn(`[API] Transcript: Failed to fetch from Recall API: ${recallError.message}`);
        // Fall through to DB/rawPayload fallback
      }
    }
    
    // PRIORITY 2: If Recall API didn't return transcript, use DB chunks
    if (transcript.length === 0) {
      console.log(`[API] Transcript: Falling back to DB chunks`);
      const transcriptChunks = await db.MeetingTranscriptChunk.findAll({
        where: { meetingArtifactId: artifact.id },
        order: [["sequence", "ASC"]],
      });

      console.log(`[API] Transcript: Found ${transcriptChunks.length} transcript chunks in DB`);

      transcript = transcriptChunks.map(chunk => ({
        speaker: chunk.speaker || "Speaker",
        text: chunk.text,
        startTimeMs: chunk.startTimeMs,
        timestamp: chunk.startTimeMs,
        isFinal: true,
      }));
    }

    // PRIORITY 3: If still no transcript, try to get from rawPayload
    if (transcript.length === 0 && artifact.rawPayload?.data?.transcript) {
      console.log(`[API] Transcript: Falling back to rawPayload`);
      console.log(`[API] Transcript: rawPayload keys:`, Object.keys(artifact.rawPayload || {}));
      console.log(`[API] Transcript: rawPayload.data keys:`, Object.keys(artifact.rawPayload?.data || {}));
      console.log(`[API] Transcript: Has transcript in rawPayload:`, !!artifact.rawPayload?.data?.transcript);
      const rawTranscript = artifact.rawPayload.data.transcript;
      console.log(`[API] Transcript: rawPayload.data.transcript type:`, typeof rawTranscript);
      
      // Handle different transcript formats from Recall API
      if (Array.isArray(rawTranscript) && rawTranscript.length > 0) {
        // Check the first element to determine format
        const firstItem = rawTranscript[0];
        console.log(`[API] Transcript: First item keys:`, Object.keys(firstItem || {}));
        console.log(`[API] Transcript: First item sample:`, JSON.stringify(firstItem).substring(0, 300));
        
        // Recall.ai format: array of segments with participant and words
        // Each segment: { participant: { id, name }, words: [{ word, start_timestamp, end_timestamp }] }
        if (firstItem.participant && firstItem.words) {
          console.log(`[API] Transcript: Using Recall.ai segment format (${rawTranscript.length} segments)`);
          transcript = rawTranscript.flatMap((segment, segIdx) => {
            const speakerName = segment.participant?.name || `Speaker ${segment.participant?.id || segIdx}`;
            // Combine words into sentences for better readability
            if (Array.isArray(segment.words) && segment.words.length > 0) {
              // Group words into sentences (by pause or punctuation)
              const text = segment.words.map(w => w.word || w.text || '').join(' ').trim();
              const startTime = segment.words[0]?.start_timestamp || 0;
              return [{
                speaker: speakerName,
                text: text,
                timestamp: startTime,
                isFinal: true,
              }];
            }
            return [];
          });
        } else {
          // Direct array format - each item is a transcript segment
          console.log(`[API] Transcript: Using direct array format (${rawTranscript.length} segments)`);
          transcript = rawTranscript.map((segment, idx) => ({
            speaker: segment.speaker || segment.speaker_id || segment.participant?.name || "Speaker",
            text: segment.text || segment.word || segment.transcript || "",
            timestamp: segment.start_timestamp || segment.start_time || segment.timestamp || 0,
            isFinal: true,
          }));
        }
      } else if (rawTranscript.words && Array.isArray(rawTranscript.words)) {
        // Object with words array format
        console.log(`[API] Transcript: Using words array format (${rawTranscript.words.length} words)`);
        transcript = rawTranscript.words.map(word => ({
          speaker: word.speaker || word.speaker_id || "Speaker",
          text: word.word || word.text || "",
          timestamp: word.start_timestamp || word.start_time || 0,
          isFinal: true,
        }));
      } else if (rawTranscript.results && Array.isArray(rawTranscript.results)) {
        // Object with results array format
        console.log(`[API] Transcript: Using results array format (${rawTranscript.results.length} results)`);
        transcript = rawTranscript.results.map(result => ({
          speaker: result.speaker || result.speaker_id || "Speaker",
          text: result.text || result.transcript || "",
          timestamp: result.start_timestamp || result.start_time || 0,
          isFinal: true,
        }));
      } else {
        console.log(`[API] Transcript: Unknown format, transcript not parsed`);
      }
    }

    console.log(`[API] Transcript: Returning ${transcript.length} transcript entries`);
    // #region agent log
    fetch('http://127.0.0.1:7250/ingest/bf0206c3-6e13-4499-92a3-7fb2b7527fcf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-details.js:finalReturn',message:'Final transcript data',data:{totalSegments:transcript.length,sampleSegments:transcript.slice(0,3).map(s=>({speaker:s.speaker,textLength:s.text?.length,textPreview:s.text?.substring(0,100)})),avgTextLength:transcript.length>0?Math.round(transcript.reduce((sum,s)=>sum+(s.text?.length||0),0)/transcript.length):0},timestamp:Date.now(),sessionId:'debug-session',runId:'transcript-debug',hypothesisId:'H1H4'})}).catch(()=>{});
    // #endregion
    return res.json({ transcript });
  } catch (error) {
    console.error(`[API] Error fetching transcript for meeting ${meetingId}:`, error);
    return res.status(500).json({ error: "Failed to fetch transcript" });
  }
}

/**
 * Get AI summary for a meeting
 * GET /api/meetings/:meetingId/summary
 */
export async function getSummary(req, res) {
  if (!req.authenticated) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { meetingId } = req.params;
  const userId = req.authentication.user.id;
  const userEmail = req.authentication.user.email || null;

  try {
    const artifact = await findAccessibleArtifact({
      meetingIdOrReadableId: meetingId,
      userId,
      userEmail,
    });

    if (!artifact) {
      return res.status(404).json({ error: "Meeting not found" });
    }

    // Get summary for this artifact
    const summary = await db.MeetingSummary.findOne({
      where: { meetingArtifactId: artifact.id },
      order: [["createdAt", "DESC"]],
    });

    if (!summary) {
      return res.json({ summary: null });
    }


    // Use the correct field names from the model
    return res.json({ 
      summary: {
        content: summary.summary || "",
        keyTopics: summary.topics || [],
        actionItems: summary.actionItems || [],
        followUps: summary.followUps || [],
        highlights: summary.highlights || [],
        detailedNotes: summary.detailedNotes || [],
        stats: summary.stats || null,
        sentiment: summary.sentiment || null,
        keyInsights: summary.keyInsights || [],
        decisions: summary.decisions || [],
        outcome: summary.outcome || null,
        source: summary.source || null,
      }
    });
  } catch (error) {
    console.error(`[API] Error fetching summary for meeting ${meetingId}:`, error);
    return res.status(500).json({ error: "Failed to fetch summary" });
  }
}

/**
 * Get action items for a meeting
 * GET /api/meetings/:meetingId/actions
 */
export async function getActionItems(req, res) {
  if (!req.authenticated) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { meetingId } = req.params;
  const userId = req.authentication.user.id;
  const userEmail = req.authentication.user.email || null;

  try {
    const artifact = await findAccessibleArtifact({
      meetingIdOrReadableId: meetingId,
      userId,
      userEmail,
    });

    if (!artifact) {
      return res.status(404).json({ error: "Meeting not found" });
    }

    // Get summary for this artifact (action items are typically in the summary)
    const summary = await db.MeetingSummary.findOne({
      where: { meetingArtifactId: artifact.id },
      order: [["createdAt", "DESC"]],
    });

    // Use the actionItems field directly from the model
    const actionItems = summary?.actionItems || [];
    

    return res.json({ actionItems });
  } catch (error) {
    console.error(`[API] Error fetching action items for meeting ${meetingId}:`, error);
    return res.status(500).json({ error: "Failed to fetch action items" });
  }
}

/**
 * Trigger on-demand enrichment for a meeting
 * POST /api/meetings/enrich
 */
export async function triggerEnrichment(req, res) {
  if (!req.authenticated) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { artifactId } = req.body;
  const userId = req.authentication.user.id;
  const userEmail = req.authentication.user.email || null;

  if (!artifactId) {
    return res.status(400).json({ error: "artifactId is required" });
  }

  try {
    // Find the meeting artifact (id or readableId) with access
    const artifact = await findAccessibleArtifact({
      meetingIdOrReadableId: artifactId,
      userId,
      userEmail,
    });

    if (!artifact) {
      console.log(`[API] Enrich: Artifact ${artifactId} not accessible for user ${userId}`);
      return res.status(404).json({ error: "Meeting artifact not found" });
    }

    console.log(`[API] Enrich: Queueing enrichment for artifact ${artifact.id}`);

    // Queue the enrichment job
    await backgroundQueue.add(
      "meeting.enrich",
      {
        meetingArtifactId: artifact.id,
        userId,
        source: "on_demand",
      },
      {
        jobId: `enrich-${artifact.id}-${Date.now()}`,
        removeOnComplete: true,
        removeOnFail: false,
      }
    );

    console.log(`[API] Enrich: Successfully queued enrichment for artifact ${artifact.id}`);

    return res.json({
      success: true,
      message: "Enrichment job queued successfully",
      artifactId: artifact.id,
    });
  } catch (error) {
    console.error(`[API] Error triggering enrichment for artifact ${artifactId}:`, error);
    return res.status(500).json({ error: "Failed to trigger enrichment" });
  }
}

/**
 * Trigger Super Agent analysis (AssemblyAI premium)
 * POST /api/meetings/:meetingId/super-agent/analyze
 */
export async function triggerSuperAgentAnalysis(req, res) {
  if (!req.authenticated) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // #region agent log - H11: Debug Super Agent trigger
  fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-details.js:triggerSuperAgent',message:'super_agent_trigger_start',data:{meetingId:req.params.meetingId,hasAssemblyAIKey:!!process.env.ASSEMBLYAI_API_KEY,userId:req.authentication?.user?.id},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H11'})}).catch(()=>{});
  // #endregion

  if (!process.env.ASSEMBLYAI_API_KEY) {
    console.log('[SuperAgent] ASSEMBLYAI_API_KEY not configured');
    return res.status(503).json({ error: "AssemblyAI is not configured" });
  }

  const { meetingId } = req.params;
  const userId = req.authentication.user.id;
  const userEmail = req.authentication.user.email || null;

  try {
    const accessibleArtifact = await findAccessibleArtifact({
      meetingIdOrReadableId: meetingId,
      userId,
      userEmail,
    });

    if (!accessibleArtifact) {
      console.log(`[SuperAgent] Artifact not found for meetingId: ${meetingId}`);
      return res.status(404).json({ error: "Meeting not found" });
    }

    const artifact = await db.MeetingArtifact.findByPk(accessibleArtifact.id, {
      include: [
        { model: db.CalendarEvent, include: [{ model: db.Calendar }] },
      ],
    });
    if (!artifact) {
      return res.status(404).json({ error: "Meeting artifact not found" });
    }
    let calendarForSuperAgent = artifact.CalendarEvent?.Calendar || null;
    if (!calendarForSuperAgent) {
      const ownerId = artifact.userId || artifact.ownerUserId;
      if (ownerId) {
        const { sequelize } = db;
        const ownerCalendar = await db.Calendar.findOne({
          where: { userId: ownerId },
          order: [[sequelize.literal('enable_super_agent'), 'DESC'], ['id', 'ASC']],
        });
        calendarForSuperAgent = ownerCalendar || null;
      }
    }
    
    // #region agent log - H11b: Debug Super Agent enabled check
    const superAgentEnabledResult = isSuperAgentEnabled(calendarForSuperAgent);
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-details.js:triggerSuperAgent',message:'super_agent_enabled_check',data:{meetingId,artifactId:artifact.id,calendarId:calendarForSuperAgent?.id,calendarEnableSuperAgent:calendarForSuperAgent?.enableSuperAgent,envSuperAgentEnabled:process.env.SUPER_AGENT_ENABLED,isSuperAgentEnabledResult:superAgentEnabledResult},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H11b'})}).catch(()=>{});
    // #endregion
    
    if (!superAgentEnabledResult) {
      console.log(`[SuperAgent] Super Agent not enabled - calendar: ${calendarForSuperAgent?.id}, enableSuperAgent: ${calendarForSuperAgent?.enableSuperAgent}, env: ${process.env.SUPER_AGENT_ENABLED}`);
      return res.status(403).json({ error: "Super Agent is not enabled for this account" });
    }
    const requestedFeatures = normalizeRequestedFeatures(req.body?.features || {});

    const analysis = await db.MeetingSuperAgentAnalysis.create({
      meetingArtifactId: artifact.id,
      userId,
      status: "queued",
      requestedFeatures,
      processingStage: "queued",
    });

    await backgroundQueue.add(
      "meeting.super_agent.start",
      {
        analysisId: analysis.id,
        meetingArtifactId: artifact.id,
        userId,
        requestedFeatures,
      },
      {
        jobId: `super-agent-start-${analysis.id}`,
        removeOnComplete: true,
        removeOnFail: false,
      }
    );

    // #region agent log - H11c: Debug Super Agent job queued
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-details.js:triggerSuperAgent',message:'super_agent_job_queued',data:{analysisId:analysis.id,meetingArtifactId:artifact.id,userId,requestedFeatures,jobId:`super-agent-start-${analysis.id}`},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H11c'})}).catch(()=>{});
    // #endregion

    return res.json({
      success: true,
      analysisId: analysis.id,
      status: analysis.status,
    });
  } catch (error) {
    console.error(`[API] Super Agent analyze error for meeting ${meetingId}:`, error);
    // #region agent log - H11d: Debug Super Agent error
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-details.js:triggerSuperAgent',message:'super_agent_trigger_error',data:{meetingId,error:error?.message,stack:error?.stack?.substring(0,500)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H11d'})}).catch(()=>{});
    // #endregion
    return res.status(500).json({ error: "Failed to trigger Super Agent analysis" });
  }
}

/**
 * Get Super Agent analysis status/results
 * GET /api/meetings/:meetingId/super-agent
 */
export async function getSuperAgentAnalysis(req, res) {
  if (!req.authenticated) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { meetingId } = req.params;
  const userId = req.authentication.user.id;
  const userEmail = req.authentication.user.email || null;

  try {
    // #region agent log - H2s: Server poll entry
    fetch('http://127.0.0.1:7250/ingest/bf0206c3-6e13-4499-92a3-7fb2b7527fcf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-details.js:getSuperAgentAnalysis',message:'sa_get_enter',data:{meetingId,userId},timestamp:Date.now(),sessionId:'debug-session',runId:'pre-fix',hypothesisId:'H2s'})}).catch(()=>{});
    // #endregion
    const accessibleArtifact = await findAccessibleArtifact({
      meetingIdOrReadableId: meetingId,
      userId,
      userEmail,
    });

    if (!accessibleArtifact) {
      return res.status(404).json({ error: "Meeting not found" });
    }

    const analysis = await db.MeetingSuperAgentAnalysis.findOne({
      where: { meetingArtifactId: accessibleArtifact.id },
      order: [["createdAt", "DESC"]],
    });

    // #region agent log - H2t: Server poll computed response shape
    try {
      const responseAnalysis = analysis
        ? {
            id: analysis.id,
            status: analysis.status,
            requestedFeatures: analysis.requestedFeatures || {},
            detailedSummary: analysis.detailedSummary || null,
            actionItems: analysis.actionItems || [],
            decisions: analysis.decisions || [],
            highlights: analysis.highlights || [],
            chapters: effectiveSuperAgentChapters(analysis),
            sentiment: analysis.sentiment || null,
            topics: analysis.topics || [],
            contentSafety: analysis.contentSafety || null,
            translation: analysis.translation || null,
            errorMessage: analysis.errorMessage || null,
            processingStage: analysis.processingStage || null,
            assemblyTranscriptStatus: analysis.assemblyTranscriptStatus || null,
            createdAt: analysis.createdAt,
            updatedAt: analysis.updatedAt,
          }
        : null;
      const keys = responseAnalysis && typeof responseAnalysis === "object" ? Object.keys(responseAnalysis) : [];
      fetch('http://127.0.0.1:7250/ingest/bf0206c3-6e13-4499-92a3-7fb2b7527fcf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-details.js:getSuperAgentAnalysis',message:'sa_get_shape',data:{meetingId,artifactId:accessibleArtifact.id,hasAnalysis:!!analysis,analysisId:analysis?.id||null,status:analysis?.status||null,responseKeys:keys},timestamp:Date.now(),sessionId:'debug-session',runId:'pre-fix',hypothesisId:'H2t'})}).catch(()=>{});
    } catch (_) {}
    // #endregion

    // #region agent log - H13: Debug Super Agent poll response
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-details.js:getSuperAgentAnalysis',message:'super_agent_poll_response',data:{meetingId,artifactId:accessibleArtifact.id,hasAnalysis:!!analysis,analysisId:analysis?.id,status:analysis?.status,hasChapters:!!(analysis?.chapters?.length),chaptersCount:analysis?.chapters?.length||0,hasTopics:!!(analysis?.topics),topicsType:typeof analysis?.topics,hasDetailedSummary:!!analysis?.detailedSummary,assemblyTranscriptId:analysis?.assemblyTranscriptId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H13'})}).catch(()=>{});
    // #endregion

    if (!analysis) {
      return res.json({ analysis: null });
    }

    return res.json({
      analysis: {
        id: analysis.id,
        status: analysis.status,
        requestedFeatures: analysis.requestedFeatures || {},
        detailedSummary: analysis.detailedSummary || null,
        actionItems: analysis.actionItems || [],
        decisions: analysis.decisions || [],
        highlights: analysis.highlights || [],
        chapters: effectiveSuperAgentChapters(analysis),
        sentiment: analysis.sentiment || null,
        topics: analysis.topics || [],
        contentSafety: analysis.contentSafety || null,
        translation: analysis.translation || null,
        errorMessage: analysis.errorMessage || null,
        processingStage: analysis.processingStage || null,
        assemblyTranscriptStatus: analysis.assemblyTranscriptStatus || null,
        createdAt: analysis.createdAt,
        updatedAt: analysis.updatedAt,
      },
    });
  } catch (error) {
    console.error(`[API] Error fetching Super Agent analysis for meeting ${meetingId}:`, error);
    return res.status(500).json({ error: "Failed to fetch Super Agent analysis" });
  }
}

/**
 * Retry/complete a stuck Super Agent analysis
 * POST /api/meetings/:meetingId/super-agent/retry
 * 
 * This endpoint manually fetches the transcript from AssemblyAI and completes
 * the analysis if it's stuck in "processing" state (e.g., webhook didn't arrive).
 */
export async function retrySuperAgentAnalysis(req, res) {
  if (!req.authenticated) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { meetingId } = req.params;
  const userId = req.authentication.user.id;
  const userEmail = req.authentication.user.email || null;

  // #region agent log - H16: Debug Super Agent retry start
  fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-details.js:retrySuperAgentAnalysis',message:'super_agent_retry_start',data:{meetingId,userId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H16'})}).catch(()=>{});
  // #endregion

  try {
    const accessibleArtifact = await findAccessibleArtifact({
      meetingIdOrReadableId: meetingId,
      userId,
      userEmail,
    });

    if (!accessibleArtifact) {
      return res.status(404).json({ error: "Meeting not found" });
    }

    const analysis = await db.MeetingSuperAgentAnalysis.findOne({
      where: { meetingArtifactId: accessibleArtifact.id },
      order: [["createdAt", "DESC"]],
    });

    if (!analysis) {
      return res.status(404).json({ error: "No Super Agent analysis found for this meeting" });
    }

    if (analysis.status === "completed") {
      return res.json({ 
        success: true, 
        message: "Analysis already completed",
        analysis: {
          id: analysis.id,
          status: analysis.status,
        }
      });
    }

    if (!analysis.assemblyTranscriptId) {
      return res.status(400).json({ error: "No AssemblyAI transcript ID found - analysis may not have been submitted" });
    }

    // Queue the completion job to process the transcript
    await backgroundQueue.add(
      "meeting.super_agent.complete",
      { 
        analysisId: analysis.id, 
        transcriptId: analysis.assemblyTranscriptId 
      },
      {
        jobId: `super-agent-retry-${analysis.id}-${Date.now()}`,
        removeOnComplete: true,
        removeOnFail: false,
      }
    );

    // #region agent log - H16b: Debug Super Agent retry job queued
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-details.js:retrySuperAgentAnalysis',message:'super_agent_retry_queued',data:{analysisId:analysis.id,transcriptId:analysis.assemblyTranscriptId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H16b'})}).catch(()=>{});
    // #endregion

    return res.json({
      success: true,
      message: "Retry job queued - analysis will be completed shortly",
      analysis: {
        id: analysis.id,
        status: analysis.status,
        assemblyTranscriptId: analysis.assemblyTranscriptId,
      }
    });
  } catch (error) {
    console.error(`[API] Error retrying Super Agent analysis for meeting ${meetingId}:`, error);
    // #region agent log - H16c: Debug Super Agent retry error
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-details.js:retrySuperAgentAnalysis',message:'super_agent_retry_error',data:{meetingId,error:error?.message},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H16c'})}).catch(()=>{});
    // #endregion
    return res.status(500).json({ error: "Failed to retry Super Agent analysis" });
  }
}

/**
 * Export all meeting artifacts (summary, transcript, etc.)
 * GET /api/meetings/:meetingId/export?format=json|markdown
 */
export async function exportMeeting(req, res) {
  if (!req.authenticated) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { meetingId } = req.params;
  const format = (req.query.format || "json").toLowerCase();
  const userId = req.authentication.user.id;
  const userEmail = req.authentication.user.email || null;

  try {
    const artifact = await findAccessibleArtifact({
      meetingIdOrReadableId: meetingId,
      userId,
      userEmail,
    });

    if (!artifact) {
      return res.status(404).json({ error: "Meeting not found" });
    }

    // Load full artifact with calendar event
    const fullArtifact = await db.MeetingArtifact.findByPk(artifact.id, {
      include: [
        { model: db.CalendarEvent, include: [{ model: db.Calendar }] },
      ],
    });

    const calendarEvent = fullArtifact?.CalendarEvent || null;

    // Get summary
    const summary = await db.MeetingSummary.findOne({
      where: { meetingArtifactId: artifact.id },
      order: [["createdAt", "DESC"]],
    });

    // Get transcript chunks
    const transcriptChunks = await db.MeetingTranscriptChunk.findAll({
      where: { meetingArtifactId: artifact.id },
      order: [["sequence", "ASC"]],
      attributes: ["speaker", "text", "startTimeMs", "endTimeMs", "sequence"],
    });

    // Build title
    const title = extractMeetingTitle(fullArtifact, calendarEvent);

    // Build export data
    const exportData = {
      title: title,
      meetingId: artifact.id,
      readableId: artifact.readableId || null,
      startTime: calendarEvent?.startTime || fullArtifact?.rawPayload?.data?.start_time || fullArtifact?.createdAt || null,
      endTime: calendarEvent?.endTime || fullArtifact?.rawPayload?.data?.end_time || null,
      platform: calendarEvent?.platform || null,
      status: fullArtifact?.status || "completed",
      exportedAt: new Date().toISOString(),

      // Summary artifacts
      summary: summary?.summary || null,
      source: summary?.source || null,
      actionItems: summary?.actionItems || [],
      followUps: summary?.followUps || [],
      topics: summary?.topics || [],
      highlights: summary?.highlights || [],
      detailedNotes: summary?.detailedNotes || [],
      keyInsights: summary?.keyInsights || [],
      decisions: summary?.decisions || [],
      sentiment: summary?.sentiment || null,
      outcome: summary?.outcome || null,
      stats: summary?.stats || null,

      // Transcript
      transcript: transcriptChunks.map((chunk) => ({
        speaker: chunk.speaker || "Speaker",
        text: chunk.text,
        startTimeMs: chunk.startTimeMs,
        endTimeMs: chunk.endTimeMs,
      })),
    };

    if (format === "markdown") {
      const md = buildMarkdownExport(exportData);
      const filename = `${(title || "meeting").replace(/[^a-zA-Z0-9-_ ]/g, "").replace(/\s+/g, "-").toLowerCase()}-export.md`;
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.send(md);
    }

    // Default: JSON
    const filename = `${(title || "meeting").replace(/[^a-zA-Z0-9-_ ]/g, "").replace(/\s+/g, "-").toLowerCase()}-export.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.json(exportData);
  } catch (error) {
    console.error(`[API] Error exporting meeting ${meetingId}:`, error);
    return res.status(500).json({ error: "Failed to export meeting" });
  }
}

/**
 * Build a Markdown document from meeting export data.
 */
function buildMarkdownExport(data) {
  const lines = [];

  lines.push(`# ${data.title || "Meeting Export"}`);
  lines.push("");

  // Metadata
  const meta = [];
  if (data.startTime) meta.push(`**Date:** ${new Date(data.startTime).toLocaleString()}`);
  if (data.platform) meta.push(`**Platform:** ${data.platform}`);
  if (data.source) meta.push(`**Source:** ${data.source}`);
  if (data.sentiment) {
    const label = typeof data.sentiment === "string" ? data.sentiment : (data.sentiment.label || data.sentiment.sentiment || "");
    if (label) meta.push(`**Sentiment:** ${label}`);
  }
  if (data.outcome) meta.push(`**Outcome:** ${data.outcome}`);
  if (data.exportedAt) meta.push(`**Exported:** ${new Date(data.exportedAt).toLocaleString()}`);
  if (meta.length > 0) {
    lines.push(meta.join("  \n"));
    lines.push("");
  }

  // Summary
  if (data.summary) {
    lines.push("## Summary");
    lines.push("");
    lines.push(data.summary);
    lines.push("");
  }

  // Key Insights
  if (data.keyInsights && data.keyInsights.length > 0) {
    lines.push("## Key Insights");
    lines.push("");
    data.keyInsights.forEach((item) => {
      const text = typeof item === "object" ? (item.text || item.insight || item.description || JSON.stringify(item)) : item;
      lines.push(`- ${text}`);
    });
    lines.push("");
  }

  // Decisions
  if (data.decisions && data.decisions.length > 0) {
    lines.push("## Decisions");
    lines.push("");
    data.decisions.forEach((item) => {
      const text = typeof item === "object" ? (item.text || item.decision || item.description || JSON.stringify(item)) : item;
      lines.push(`- ${text}`);
    });
    lines.push("");
  }

  // Topics
  if (data.topics && data.topics.length > 0) {
    lines.push("## Topics");
    lines.push("");
    data.topics.forEach((topic, idx) => {
      if (typeof topic === "string") {
        lines.push(`### ${topic}`);
      } else {
        const title = topic.title || topic.name || topic.topic || topic.heading || `Topic ${idx + 1}`;
        lines.push(`### ${title}`);
        if (topic.summary) lines.push(`${topic.summary}`);
        if (topic.details) lines.push(`${topic.details}`);
        const arrayKeys = ["items", "points", "bullets", "notes"];
        for (const key of arrayKeys) {
          if (Array.isArray(topic[key])) {
            topic[key].forEach((item) => {
              const text = typeof item === "string" ? item : (item.text || item.summary || item.description || JSON.stringify(item));
              lines.push(`- ${text}`);
            });
          }
        }
      }
      lines.push("");
    });
  }

  // Highlights
  if (data.highlights && data.highlights.length > 0) {
    lines.push("## Highlights");
    lines.push("");
    data.highlights.forEach((item, idx) => {
      if (typeof item === "object") {
        const title = item.title || `Highlight ${idx + 1}`;
        const text = item.content || item.summary || item.text || "";
        lines.push(`**${title}**`);
        if (text) lines.push(text);
        if (item.speaker) lines.push(`_Speaker: ${item.speaker}_`);
      } else {
        lines.push(`- ${item}`);
      }
      lines.push("");
    });
  }

  // Detailed Notes
  if (data.detailedNotes && data.detailedNotes.length > 0) {
    lines.push("## Detailed Notes");
    lines.push("");
    data.detailedNotes.forEach((item) => {
      if (typeof item === "object") {
        const speaker = item.speaker ? `**${item.speaker}:** ` : "";
        const text = item.paraphrase || item.content || item.note || item.summary || item.text || "";
        lines.push(`- ${speaker}${text}`);
        if (item.quote) lines.push(`  > "${item.quote}"`);
      } else {
        lines.push(`- ${item}`);
      }
    });
    lines.push("");
  }

  // Action Items
  if (data.actionItems && data.actionItems.length > 0) {
    lines.push("## Action Items");
    lines.push("");
    data.actionItems.forEach((item) => {
      if (typeof item === "object") {
        const text = item.text || item.action || item.task || item.description || JSON.stringify(item);
        const assignee = item.assignee ? ` (${item.assignee})` : "";
        lines.push(`- [ ] ${text}${assignee}`);
      } else {
        lines.push(`- [ ] ${item}`);
      }
    });
    lines.push("");
  }

  // Follow-ups
  if (data.followUps && data.followUps.length > 0) {
    lines.push("## Follow-ups");
    lines.push("");
    data.followUps.forEach((item) => {
      const text = typeof item === "object" ? (item.text || item.followUp || item.description || item.task || JSON.stringify(item)) : item;
      lines.push(`- ${text}`);
    });
    lines.push("");
  }

  // Stats
  if (data.stats) {
    lines.push("## Stats");
    lines.push("");
    if (data.stats.durationSeconds) {
      const totalMins = Math.round(data.stats.durationSeconds / 60);
      lines.push(`**Duration:** ${totalMins} minutes`);
    }
    if (data.stats.speakers && data.stats.speakers.length > 0) {
      lines.push("");
      lines.push("| Speaker | Talk Time | % |");
      lines.push("|---------|-----------|---|");
      data.stats.speakers.forEach((s) => {
        const secs = Math.round(s.talkTimeSeconds || 0);
        const mins = Math.floor(secs / 60);
        const rem = secs % 60;
        const time = mins > 0 ? `${mins}m ${rem}s` : `${secs}s`;
        const pct = s.talkTimePercent != null ? `${s.talkTimePercent.toFixed(1)}%` : "-";
        lines.push(`| ${s.name || "Speaker"} | ${time} | ${pct} |`);
      });
    }
    lines.push("");
  }

  // Transcript
  if (data.transcript && data.transcript.length > 0) {
    lines.push("## Transcript");
    lines.push("");
    let currentSpeaker = null;
    data.transcript.forEach((chunk) => {
      if (chunk.speaker !== currentSpeaker) {
        currentSpeaker = chunk.speaker;
        lines.push("");
        lines.push(`**${chunk.speaker || "Speaker"}:**`);
      }
      lines.push(chunk.text || "");
    });
    lines.push("");
  }

  return lines.join("\n");
}
