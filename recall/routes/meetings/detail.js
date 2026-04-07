import db from "../../db.js";
import {
  effectiveSuperAgentChapters,
  isSuperAgentEnabled,
  isUserPremium,
} from "../../utils/super-agent.js";
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
 * Strip HTML tags from text and clean up meaningless content
 */
function stripHtml(html) {
  if (!html || typeof html !== 'string') return html;
  // Remove HTML tags but preserve text content
  let text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
  // Remove strings that are just repeated characters (like "____" or "----")
  if (/^[_\-=~.]{3,}$/.test(text)) {
    return null;
  }
  // Remove strings that are mostly whitespace or special chars
  const alphanumericContent = text.replace(/[^a-zA-Z0-9]/g, '');
  if (alphanumericContent.length < 3) {
    return null;
  }
  return text;
}

/**
 * Extract description from a calendar event
 */
function getDescriptionFromEvent(event) {
  if (!event) return null;
  const raw = event?.recallData?.raw || {};
  
  let description = null;
  if (event.platform === "google_calendar") {
    description = raw["description"] || null;
  } else if (event.platform === "microsoft_outlook") {
    description = raw["body"]?.content || raw["bodyPreview"] || null;
  }
  
  // Strip HTML tags if present
  if (description) {
    description = stripHtml(description);
    // Return null if description is empty after stripping
    if (!description || description.length === 0) {
      return null;
    }
  }
  
  return description;
}

/**
 * Extract description from an artifact
 */
function getDescriptionFromArtifact(artifact) {
  if (!artifact) return null;
  const data = artifact?.rawPayload?.data || {};
  
  let description = null;
  // Check artifact data for description
  if (data.description) {
    description = data.description;
  } else if (data.bot_metadata?.meeting_metadata?.description) {
    // Check bot metadata
    description = data.bot_metadata.meeting_metadata.description;
  }
  
  // Strip HTML tags if present
  if (description) {
    description = stripHtml(description);
    // Return null if description is empty after stripping
    if (!description || description.length === 0) {
      return null;
    }
  }
  
  return description;
}

/**
 * Derive a human-readable meeting title from various sources.
 */
function extractMeetingTitle(artifact, calendarEvent) {
  // 0) Artifact's pre-computed title field (if available)
  if (artifact?.title && !isGenericMeetingTitle(artifact.title)) {
    return artifact.title;
  }
  
  // 1) Calendar event title (virtual field that gets summary/subject from raw data)
  if (calendarEvent?.title && !isGenericMeetingTitle(calendarEvent.title)) {
    return calendarEvent.title;
  }

  // 2) Calendar event recallData title fields (check multiple possible locations)
  const calEventTitle = 
    calendarEvent?.recallData?.meeting_title || 
    calendarEvent?.recallData?.title ||
    calendarEvent?.recallData?.raw?.summary ||
    calendarEvent?.recallData?.raw?.subject ||
    calendarEvent?.recallData?.raw?.title;
  if (calEventTitle && !isGenericMeetingTitle(calEventTitle)) {
    return calEventTitle;
  }

  // 3) Artifact payload title
  if (artifact?.rawPayload?.data?.title && !isGenericMeetingTitle(artifact.rawPayload.data.title)) {
    return artifact.rawPayload.data.title;
  }

  // 4) Bot calendar_meetings title (from Recall API bot data)
  // This is often the most reliable source for meeting titles
  const botCalendarMeetings = artifact?.rawPayload?.data?.bot_metadata?.calendar_meetings || 
                               artifact?.rawPayload?.data?.calendar_meetings ||
                               artifact?.rawPayload?.bot?.calendar_meetings;
  if (Array.isArray(botCalendarMeetings) && botCalendarMeetings.length > 0) {
    for (const cm of botCalendarMeetings) {
      if (cm?.title && !isGenericMeetingTitle(cm.title)) {
        return cm.title;
      }
    }
  }

  // 5) Bot meeting_metadata title (if present)
  const botMetaTitle = artifact?.rawPayload?.data?.bot_metadata?.meeting_metadata?.title;
  if (botMetaTitle && !isGenericMeetingTitle(botMetaTitle)) {
    return botMetaTitle;
  }

  // 6) Check artifact rawPayload for other title fields
  const artifactTitle = 
    artifact?.rawPayload?.data?.meeting_title ||
    artifact?.rawPayload?.data?.event_title ||
    artifact?.rawPayload?.data?.calendar_event?.title ||
    artifact?.rawPayload?.data?.calendar_event?.summary ||
    artifact?.rawPayload?.data?.calendar_event?.subject;
  if (artifactTitle && !isGenericMeetingTitle(artifactTitle)) {
    return artifactTitle;
  }

  // 7) Derive from meeting URL
  const meetingUrl = artifact?.rawPayload?.data?.meeting_url || calendarEvent?.meetingUrl;
  if (meetingUrl) {
    const urlTitle = extractTitleFromUrl(meetingUrl);
    if (urlTitle) return urlTitle;
  }

  // 8) Build from participants
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

  // 9) Date-based fallback
  const startTime = calendarEvent?.startTime || artifact?.rawPayload?.data?.start_time || artifact?.createdAt;
  if (startTime) {
    const date = new Date(startTime);
    return `Meeting on ${date.toLocaleDateString()}`; // Match list.js format exactly
  }

  return "Untitled Meeting";
}

export default async (req, res) => {
  // #region agent log
  fetch('http://127.0.0.1:7638/ingest/79656976-3d7d-40e3-8c2f-1fcd56f4a972',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'72392a'},body:JSON.stringify({sessionId:'72392a',location:'recall/routes/meetings/detail.js:entry',message:'meeting detail handler entry',data:{meetingId:req.params?.id,hasAuth:!!req.authenticated,userId:req.authentication?.user?.id},timestamp:Date.now(),hypothesisId:'H3'})}).catch(()=>{});
  // #endregion
  if (!req.authenticated) {
    return res.redirect("/sign-in");
  }

  const userId = req.authentication.user.id;
  const meetingId = req.params.id;

  // Load full user model for premium/trial check
  const currentUser = await db.User.findByPk(userId);
  if (!currentUser) {
    return res.redirect("/sign-in");
  }

  try {
  // FAST INITIAL LOAD: Only fetch minimal metadata, no transcript chunks
  // Artifacts will be lazy-loaded via JavaScript after page renders
  
  let hasAccess = false;
  let isOwner = false;
  let shareInfo = null;
  
  // Find artifact WITHOUT transcript chunks for fast initial load
  let artifact = await db.MeetingArtifact.findOne({
    where: {
      [Op.or]: [
        { id: meetingId },
        { readableId: meetingId },
      ],
    },
    attributes: {
      include: ['title'], // Explicitly include title field
    },
    include: [
      {
        model: db.CalendarEvent,
        include: [{ model: db.Calendar }],
      },
      {
        model: db.MeetingSummary,
      },
      // NO MeetingTranscriptChunk - this is what makes it slow!
    ],
    // rawPayload should be loaded by default (it's a required field in the model)
  });
  
  if (artifact) {
    isOwner = artifact.userId === userId || artifact.ownerUserId === userId;
    
    if (isOwner) {
      hasAccess = true;
    } else {
      const shareWhereClause = {
        meetingArtifactId: artifact.id,
        status: "accepted",
        [Op.or]: [{ sharedWithUserId: userId }],
      };
      if (currentUser?.email) {
        shareWhereClause[Op.or].push({ sharedWithEmail: currentUser.email.toLowerCase() });
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
      artifact = null;
    }
  }

  let summary = null;
  let calendarEvent = null;
  let superAgentAnalysis = null;

  if (artifact) {
    summary = artifact.MeetingSummaries?.[0] || null;
    calendarEvent = artifact.CalendarEvent;
    try {
      superAgentAnalysis = await db.MeetingSuperAgentAnalysis.findOne({
        where: { meetingArtifactId: artifact.id },
        order: [["createdAt", "DESC"]],
      });
    } catch (err) {
      console.warn("[meetings/detail] MeetingSuperAgentAnalysis lookup failed:", err?.message || err);
      superAgentAnalysis = null;
    }
  } else {
    // Try to find as summary
    summary = await db.MeetingSummary.findOne({
      where: { id: meetingId, userId },
      include: [
        {
          model: db.MeetingArtifact,
          required: false,
          // NO MeetingTranscriptChunk here either
        },
        {
          model: db.CalendarEvent,
          include: [{ model: db.Calendar }],
        },
      ],
    });

    if (!summary) {
      return res.render("404.ejs", { notice: req.notice });
    }

    artifact = summary.MeetingArtifact;
    calendarEvent = summary.CalendarEvent;
    if (artifact?.id) {
      try {
        superAgentAnalysis = await db.MeetingSuperAgentAnalysis.findOne({
          where: { meetingArtifactId: artifact.id },
          order: [["createdAt", "DESC"]],
        });
      } catch (err) {
        console.warn("[meetings/detail] MeetingSuperAgentAnalysis lookup failed:", err?.message || err);
        superAgentAnalysis = null;
      }
    }
  }

  // #region agent log
  fetch('http://127.0.0.1:7638/ingest/79656976-3d7d-40e3-8c2f-1fcd56f4a972',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'72392a'},body:JSON.stringify({sessionId:'72392a',location:'recall/routes/meetings/detail.js:afterSummary',message:'after summary resolution',data:{hasArtifact:!!artifact,hasSummary:!!summary},timestamp:Date.now(),hypothesisId:'H4'})}).catch(()=>{});
  // #endregion
  // Get transcript chunk count (fast query, no data transfer)
  let transcriptChunkCount = 0;
  if (artifact?.id) {
    transcriptChunkCount = await db.MeetingTranscriptChunk.count({
      where: { meetingArtifactId: artifact.id },
    });
  }

  // Resolve calendar for Super Agent: use meeting's calendar event, or owner's calendar if no event linked
  let calendarForSuperAgent = calendarEvent?.Calendar || null;
  if (!calendarForSuperAgent && artifact) {
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

  // Try to merge with upcoming event data if available (same pattern as past meetings page)
  // This can provide better title/description from the calendar event
  let matchingUpcomingEvent = null;
  const recallEventIdForMerge =
    calendarEvent?.recallId ||
    artifact?.recallEventId ||
    artifact?.rawPayload?.data?.recall_event_id ||
    artifact?.rawPayload?.data?.calendar_event_id ||
    null;
  
  if (recallEventIdForMerge) {
    // Find matching upcoming calendar event by recallId
    try {
      const now = new Date();
      matchingUpcomingEvent = await db.CalendarEvent.findOne({
        where: {
          recallId: recallEventIdForMerge,
          startTime: { [Op.gte]: now }, // Only future events
        },
        include: [{ model: db.Calendar }],
      });
      
      // Extract description from upcoming event if found
      if (matchingUpcomingEvent) {
        matchingUpcomingEvent.description = getDescriptionFromEvent(matchingUpcomingEvent);
      }
    } catch (err) {
      console.warn("[meetings/detail] Error fetching matching upcoming event:", err?.message || err);
    }
  }

  // Build meeting data - MINIMAL for fast initial render
  // Heavy data (transcript, stats) will be lazy-loaded

  // Use database title field directly (source of truth)
  // If it's generic or missing, compute and update it
  let extractedTitle = artifact?.title && !isGenericMeetingTitle(artifact.title) 
    ? artifact.title 
    : null;
  
  // If database title is generic/missing, compute it from rawPayload and update database
  if (!extractedTitle) {
    extractedTitle = extractMeetingTitle(artifact, calendarEvent);
    
    // Use upcoming event title if available and better (same pattern as past meetings page)
    if (matchingUpcomingEvent?.title && !isGenericMeetingTitle(matchingUpcomingEvent.title)) {
      extractedTitle = matchingUpcomingEvent.title;
    }
    
    // Update the database with the computed title so we don't have to compute it again
    // This ensures the database is the source of truth going forward
    // Do this asynchronously (fire and forget) to avoid blocking the request
    if (extractedTitle && !isGenericMeetingTitle(extractedTitle) && artifact.id) {
      const oldTitle = artifact.title;
      const artifactId = artifact.id;
      // Update database asynchronously without blocking the request
      // Don't modify the artifact instance to avoid Sequelize issues
      artifact.update({ title: extractedTitle }, { silent: true }).then(() => {
      }).catch((err) => {
        console.warn(`[meetings/detail] Failed to update artifact title:`, err?.message || err);
      });
    }
  }
  
  // Extract description from calendar event and artifact (same way as past meetings page)
  const descriptionFromEvent = getDescriptionFromEvent(calendarEvent);
  const descriptionFromArtifact = getDescriptionFromArtifact(artifact);
  // Prefer upcoming event description, then artifact description, fallback to event description
  let description = descriptionFromArtifact || descriptionFromEvent;
  if (matchingUpcomingEvent?.description) {
    description = matchingUpcomingEvent.description;
  }

  // Create display title: use extracted title directly
  // "Meeting on {date}" is now treated as generic by isGenericMeetingTitle, so it won't
  // reach here from the DB path. If extractMeetingTitle returns it as a last resort,
  // it's still better than bare "Meeting".
  let displayTitle = extractedTitle || 'Untitled Meeting';

  // #region agent log
  (() => {
    const d = artifact?.rawPayload?.data || {};
    const ce = d.calendar_event || {};
    const step6Title = d.meeting_title || d.event_title || ce.title || ce.summary || ce.subject;
    const isGeneric = artifact?.title ? isGenericMeetingTitle(artifact.title) : null;
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'recall/routes/meetings/detail.js:title_extraction',message:'Detail page title extraction',data:{meetingId,artifactId:artifact?.id,artifactTitleDb:artifact?.title,isGenericMeetingTitleForDb:isGeneric,step6Title,payloadTitle:d.title,payloadMeetingTitle:d.meeting_title,extractedTitle,displayTitle,codeVersion:'fix-v3-writethrough'},timestamp:Date.now(),hypothesisId:'H1-H5',runId:'post-fix'})}).catch(()=>{});
  })();
  // #endregion

  const meeting = {
    id: artifact?.id || summary?.id,
    readableId: artifact?.readableId || null,
    title: extractedTitle,
    displayTitle: displayTitle,
    description: description,
    startTime: calendarEvent?.startTime || artifact?.rawPayload?.data?.start_time || artifact?.createdAt || summary?.createdAt,
    endTime: calendarEvent?.endTime || artifact?.rawPayload?.data?.end_time || null,
    status: artifact?.status || summary?.status || "completed",
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
    teamsRecordingUrl:
      artifact?.rawPayload?.data?.teamsRecordingUrl ||
      artifact?.rawPayload?.data?.teams_video_url ||
      artifact?.rawPayload?.teamsRecordingUrl ||
      artifact?.rawPayload?.data?.sharePointRecordingUrl ||
      null,
    
    // Summary data - include if available (usually small)
    summary: summary?.summary || null,
    actionItems: summary?.actionItems || [],
    followUps: summary?.followUps || [],
    topics: summary?.topics || [],
    highlights: summary?.highlights || [],
    detailedNotes: summary?.detailedNotes || [],
    
    // Sentiment and insights
    sentiment: summary?.sentiment 
      ? (typeof summary.sentiment === 'string' 
          ? summary.sentiment 
          : (summary.sentiment.label || summary.sentiment.sentiment || 'neutral'))
      : null,
    sentimentData: summary?.sentiment && typeof summary.sentiment === 'object' ? summary.sentiment : null,
    keyInsights: summary?.keyInsights || [],
    decisions: summary?.decisions || [],
    outcome: summary?.outcome || null,
    stats: summary?.stats || null, // Stats will be computed from transcript when lazy-loaded
    summarySource: summary?.source || null,

    superAgentAnalysis: superAgentAnalysis
      ? {
          id: superAgentAnalysis.id,
          status: superAgentAnalysis.status,
          requestedFeatures: superAgentAnalysis.requestedFeatures || {},
          detailedSummary: superAgentAnalysis.detailedSummary || null,
          actionItems: superAgentAnalysis.actionItems || [],
          decisions: superAgentAnalysis.decisions || [],
          highlights: superAgentAnalysis.highlights || [],
          chapters: effectiveSuperAgentChapters(superAgentAnalysis),
          sentiment: superAgentAnalysis.sentiment || null,
          topics: superAgentAnalysis.topics || [],
          contentSafety: superAgentAnalysis.contentSafety || null,
          translation: superAgentAnalysis.translation || null,
          errorMessage: superAgentAnalysis.errorMessage || null,
          processingStage: superAgentAnalysis.processingStage || null,
          assemblyTranscriptStatus: superAgentAnalysis.assemblyTranscriptStatus || null,
          createdAt: superAgentAnalysis.createdAt,
          updatedAt: superAgentAnalysis.updatedAt,
        }
      : null,
    superAgentEnabled: isSuperAgentEnabled(calendarForSuperAgent),
    hasPremiumAccess: isSuperAgentEnabled(calendarForSuperAgent),
    isPremiumUser: isUserPremium(currentUser),
    
    // LAZY LOADING: Transcript will be fetched via API
    transcript: [], // Empty - will be lazy-loaded
    transcriptChunkCount, // Tell the UI how many chunks to expect
    lazyLoadTranscript: transcriptChunkCount > 0, // Flag to trigger lazy loading
    
    // Metadata
    createdAt: artifact?.createdAt || summary?.createdAt,
    rawPayload: null, // Don't send raw payload to client - it's huge
    
    // For enrichment trigger
    artifactId: artifact?.id || null,
    hasBeenEnriched: !!summary,
    
    // Ownership and sharing
    isOwner,
    isShared: !!shareInfo,
    shareInfo: shareInfo ? {
      accessLevel: shareInfo.accessLevel,
      sharedBy: shareInfo.sharedByUser ? {
        name: shareInfo.sharedByUser.name,
        email: shareInfo.sharedByUser.email,
      } : null,
      sharedAt: shareInfo.createdAt,
    } : null,
  };

  // Get publish deliveries for this meeting
  let publishDeliveries = [];
  // #region agent log
  fetch('http://127.0.0.1:7638/ingest/79656976-3d7d-40e3-8c2f-1fcd56f4a972',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'72392a'},body:JSON.stringify({sessionId:'72392a',location:'recall/routes/meetings/detail.js:beforePublishDelivery',message:'before PublishDelivery',data:{hasSummary:!!summary,summaryId:summary?.id},timestamp:Date.now(),hypothesisId:'H5'})}).catch(()=>{});
  // #endregion
  try {
    if (summary) {
      publishDeliveries = await db.PublishDelivery.findAll({
        where: { meetingSummaryId: summary.id },
        include: [{ model: db.PublishTarget }],
        order: [["createdAt", "DESC"]],
      });
    }
  } catch (err) {
    console.warn("[meetings/detail] PublishDelivery lookup failed:", err?.message || err);
  }

  const enableLocalTelemetry = process.env.NODE_ENV === "development" && process.env.ENABLE_LOCAL_TELEMETRY === "true";
  return res.render("meeting-detail.ejs", {
    notice: req.notice,
    user: req.authentication.user,
    meeting,
    publishDeliveries,
    enableLocalTelemetry,
  });
  } catch (err) {
    // #region agent log
    fetch('http://127.0.0.1:7638/ingest/79656976-3d7d-40e3-8c2f-1fcd56f4a972',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'72392a'},body:JSON.stringify({sessionId:'72392a',location:'recall/routes/meetings/detail.js:catch',message:'meeting detail handler error',data:{errorMessage:err?.message,errorName:err?.name,stackSnippet:(err?.stack||'').split('\n').slice(0,5).join(' | ')},timestamp:Date.now(),hypothesisId:'error'})}).catch(()=>{});
    // #endregion
    throw err;
  }
};

