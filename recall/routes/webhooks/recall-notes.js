import { backgroundQueue } from "../../queue.js";
import db from "../../db.js";
import { v4 as uuidv4 } from "uuid";
import Recall from "../../services/recall/index.js";
import { generateUniqueReadableMeetingId } from "../../utils/meeting-id.js";
import {
  extractMeetingMetadata,
  normalizeMeetingUrl,
} from "../../utils/meeting-metadata-extractor.js";

/**
 * Webhook handler for Recall.ai transcript and bot events.
 *
 * Events we handle:
 *   - transcript.partial_data: Streaming partial transcript (may be revised)
 *   - transcript.data: Final transcript segment(s)
 *   - transcript.done: Transcription completed
 *   - transcript.failed: Transcription failed
 *   - recording.done: Recording finished (good fallback trigger)
 *   - bot.status_change: Bot lifecycle events
 *   - (legacy) notes: Recall Notepad summary/action items
 */

/**
 * Extract recallEventId and recallBotId from webhook payload.
 * Transcript/recording webhooks use data.bot.id (nested); bot.status_change uses data.bot_id.
 * Extracting both prevents duplicate artifacts: when IDs are null, every webhook creates a new
 * artifact and readableId collisions cause "Could not generate unique readableId after 20 retries".
 */
function extractRecallIdentifiers(payload) {
  const data = payload?.data || payload;

  // Bot status change: data.bot_id. Transcript/recording events: data.bot.id (nested object).
  const recallBotId =
    data?.bot_id ||
    data?.botId ||
    data?.bot?.id ||
    payload?.bot_id ||
    payload?.botId ||
    (payload?.event === "bot.status_change" ? payload?.data?.bot_id : null) ||
    null;

  const recallEventId =
    data?.calendar_event_id ||
    data?.recall_event_id ||
    data?.event_id ||
    data?.meeting_id ||
    (data?.id && data?.id !== recallBotId ? data.id : null) ||
    null;

  return { recallEventId, recallBotId };
}

/**
 * Extract transcript segments from various payload shapes.
 * 
 * Recall API transcript formats:
 * 1. Array of participant segments: [{ participant: { name: "..." }, words: [{ text: "...", start_timestamp: {...}, end_timestamp: {...} }] }]
 * 2. Streaming events: data.words[] with { text, start_time, end_time, speaker }
 * 3. Legacy segments: data.transcript.segments[] or data.segments[]
 */
function extractTranscriptSegments(payload, eventType) {
  const data = payload?.data || payload;
  
  // Format 1: Recall API full transcript - array of participant segments with words
  // Each item has: { participant: { name: "..." }, words: [{ text: "...", start_timestamp: {...}, end_timestamp: {...} }] }
  const transcript = data?.transcript;
  if (Array.isArray(transcript) && transcript.length > 0 && transcript[0]?.words) {
    return transcript.map((segment, idx) => {
      const words = segment.words || [];
      const text = words.map((w) => w.text || "").join(" ");
      
      // Extract timestamps - they can be in { relative: number, absolute: string } format
      const firstWord = words[0];
      const lastWord = words[words.length - 1];
      
      let startTimeMs = null;
      if (firstWord?.start_timestamp) {
        if (typeof firstWord.start_timestamp.relative === 'number') {
          startTimeMs = firstWord.start_timestamp.relative * 1000;
        } else if (typeof firstWord.start_timestamp === 'number') {
          startTimeMs = firstWord.start_timestamp * 1000;
        }
      }
      
      let endTimeMs = null;
      if (lastWord?.end_timestamp) {
        if (typeof lastWord.end_timestamp.relative === 'number') {
          endTimeMs = lastWord.end_timestamp.relative * 1000;
        } else if (typeof lastWord.end_timestamp === 'number') {
          endTimeMs = lastWord.end_timestamp * 1000;
        }
      }
      
      const speaker = segment.participant?.name || segment.speaker || null;
      
      return { text, startTimeMs, endTimeMs, speaker, sequence: idx };
    }).filter(s => s.text && s.text.trim().length > 0);
  }

  // Format 2: Streaming events often use `words` array with { text, start_time, end_time, speaker }
  if (Array.isArray(data?.words) && data.words.length > 0) {
    // Combine words into a single segment for this chunk
    const words = data.words;
    const text = words.map((w) => w.text || w.word || "").join(" ");
    const startTimeMs =
      words[0]?.start_time != null ? words[0].start_time * 1000 : null;
    const endTimeMs =
      words[words.length - 1]?.end_time != null
        ? words[words.length - 1].end_time * 1000
        : null;
    const speaker = words[0]?.speaker || data?.speaker || null;
    return [{ text, startTimeMs, endTimeMs, speaker, sequence: 0 }];
  }

  // Format 3: Legacy segments array
  const segments =
    data?.transcript?.segments ||
    data?.segments ||
    data?.transcript_segments ||
    [];
  if (!Array.isArray(segments)) {
    return [];
  }
  return segments
    .filter((s) => s?.text)
    .map((s, idx) => ({
      sequence: idx,
      startTimeMs:
        s?.startTimeMs ??
        s?.start_ms ??
        (typeof s?.start === "number" ? s.start * 1000 : null) ??
        (typeof s?.start_time === "number" ? s.start_time * 1000 : null),
      endTimeMs:
        s?.endTimeMs ??
        s?.end_ms ??
        (typeof s?.end === "number" ? s.end * 1000 : null) ??
        (typeof s?.end_time === "number" ? s.end_time * 1000 : null),
      speaker: s?.speaker || s?.speaker_id || s?.participant || null,
      text: s.text,
    }));
}

export default async (req, res) => {
  const rawPayload = req.body || {};
  const event = rawPayload?.event || rawPayload?.type || null;
  const { recallEventId, recallBotId } = extractRecallIdentifiers(rawPayload);

  console.log(
    `[RECALL-NOTES] Received webhook: event=${event}, recallEventId=${recallEventId}, recallBotId=${recallBotId}`
  );
  console.log(`[RECALL-NOTES] Payload keys: ${Object.keys(rawPayload).join(", ")}`);
  console.log(`[RECALL-NOTES] Full payload: ${JSON.stringify(rawPayload).substring(0, 1000)}`);
  
  // Log recording and transcription data presence for debugging
  const data = rawPayload?.data || rawPayload;
  const hasRecording = !!(data?.video_url || data?.recording_url || data?.videoUrl || data?.recordingUrl);
  const hasTranscript = !!(data?.transcript?.segments || data?.transcript_segments || data?.segments || data?.words);
  console.log(`[RECALL-NOTES] Recording data present: ${hasRecording}, Transcript data present: ${hasTranscript}`);
  
  // For bot.status_change events, log the status details with full instrumentation for debugging leave behavior
  if (event === "bot.status_change") {
    const status = data?.status || rawPayload?.status;
    const statusCode = status?.code;
    const subCode = status?.sub_code;
    const statusMessage = status?.message;
    // Log full status object for debugging bot_detection / automatic_leave (participant info, etc.)
    const fullStatusJson = JSON.stringify(status || {});
    console.log(`[RECALL-NOTES] Bot status change: botId=${recallBotId}, eventId=${recallEventId}, code=${statusCode}, sub_code=${subCode}, message=${statusMessage}`);
    console.log(`[RECALL-NOTES] Full status object (for leave debugging): ${fullStatusJson}`);
    // Log full payload for leave events so we can diagnose why bot stayed (e.g. Fireflies blocking)
    if (statusCode === "left_call" || statusCode === "call_ended" || statusCode === "left" || subCode === "automatic_leave" || subCode === "bot_detection" || subCode === "kicked") {
      console.log(`[RECALL-NOTES] LEAVE EVENT - full payload: ${JSON.stringify(rawPayload)}`);
    }
    // #region agent log
    const codeStr = String(statusCode || "").toLowerCase();
    const isJoinFailure = /fail|error|fatal|reject|denied|blocked/.test(codeStr) || subCode === "kicked";
    let hypothesisId = "H4";
    if (isJoinFailure || subCode === "kicked") hypothesisId = "H1";
    else if (subCode === "bot_detection") hypothesisId = "H2";
    else if (subCode === "automatic_leave" || ((statusCode === "left_call" || statusCode === "call_ended") && !subCode)) hypothesisId = "H3";
    else if (statusCode === "joined_call" || statusCode === "in_call") hypothesisId = "H-joined";
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'recall-notes.js:bot.status_change',message:'Bot status change',data:{recallBotId,recallEventId,statusCode,subCode,statusMessage,fullStatus:status},timestamp:Date.now(),hypothesisId})}).catch(()=>{});
    // #endregion
    
    // Log all status changes for debugging
    if (statusCode === "joined_call" || statusCode === "in_call") {
      console.log(`[RECALL-NOTES] ✅ Bot joined/joined call: botId=${recallBotId}, eventId=${recallEventId}`);
    }
    
    // Log specific disconnection/leave events
    if (statusCode === "left_call" || statusCode === "call_ended" || statusCode === "left" || subCode === "automatic_leave" || subCode === "bot_detection" || subCode === "kicked") {
      console.log(`[RECALL-NOTES] ⚠️  Bot disconnected/left: botId=${recallBotId}, eventId=${recallEventId}, reason=${subCode || statusCode}, message=${statusMessage || 'N/A'}`);
      if (subCode === "automatic_leave") {
        console.log(`[RECALL-NOTES] Bot left due to automatic_leave setting (likely noone_joined_timeout or waiting_room_timeout)`);
      } else if (subCode === "bot_detection") {
        console.log(`[RECALL-NOTES] Bot left due to bot_detection (only bots detected in meeting)`);
      } else if (subCode === "kicked") {
        console.log(`[RECALL-NOTES] Bot was kicked from meeting (likely by host)`);
      }
    }
  }
  
  if (hasRecording) {
    console.log(`[RECALL-NOTES] Recording URLs: video=${data?.video_url || data?.videoUrl || 'N/A'}, audio=${data?.audio_url || data?.audioUrl || 'N/A'}`);
  }
  
  if (hasTranscript) {
    const segmentCount = (data?.transcript?.segments || data?.transcript_segments || data?.segments || []).length;
    const wordCount = (data?.words || []).length;
    console.log(`[RECALL-NOTES] Transcript: ${segmentCount} segments, ${wordCount} words`);
  }

  try {
    // For bot.status_change with "done" status, we need to fetch the bot data from Recall API
    // to get the recording URLs and transcript
    let botData = null;
    const statusCode = data?.status?.code || rawPayload?.status?.code;
    if (event === "bot.status_change" && statusCode === "done" && recallBotId) {
      console.log(`[RECALL-NOTES] Bot ${recallBotId} is done, fetching bot data from Recall API...`);
      try {
        // Small delay to ensure media is ready
        await new Promise(resolve => setTimeout(resolve, 2000));
        botData = await Recall.getBot(recallBotId);
        console.log(`[RECALL-NOTES] Fetched bot data: recordings=${botData?.recordings?.length || 0}, status=${botData?.status?.code}`);
        if (botData?.recordings?.length > 0) {
          console.log(`[RECALL-NOTES] Recording media_shortcuts: ${JSON.stringify(botData.recordings[0]?.media_shortcuts || {}).substring(0, 500)}`);
        }
      } catch (fetchErr) {
        console.error(`[RECALL-NOTES] Failed to fetch bot data: ${fetchErr.message}`);
      }
    }
    
    // Find associated calendar event (if any)
    // First try by recallEventId, then by recallBotId if we have bot data
    let calendarEvent = null;
    if (recallEventId) {
      calendarEvent = await db.CalendarEvent.findOne({
        where: { recallId: recallEventId },
        include: [{ model: db.Calendar }],
      });
    }
    
    // If no calendar event found by recallEventId, try to find by bot's calendar_event_id
    if (!calendarEvent && botData?.calendar_event_id) {
      calendarEvent = await db.CalendarEvent.findOne({
        where: { recallId: botData.calendar_event_id },
        include: [{ model: db.Calendar }],
      });
      console.log(`[RECALL-NOTES] Found calendar event by bot's calendar_event_id: ${calendarEvent?.id || 'not found'}`);
    }

    // Find or create MeetingArtifact
    // Try to find by recallEventId first, then by recallBotId
    let artifact = null;
    const effectiveRecallEventId = recallEventId || botData?.calendar_event_id;
    
    if (effectiveRecallEventId) {
      artifact = await db.MeetingArtifact.findOne({
        where: { recallEventId: effectiveRecallEventId },
      });
    }
    
    // If not found by event ID, try by bot ID
    if (!artifact && recallBotId) {
      artifact = await db.MeetingArtifact.findOne({
        where: { recallBotId },
      });
    }

    // Merge bot data into the payload if we fetched it
    // Extract video and audio URLs from media_shortcuts
    let videoUrl = null;
    let audioUrl = null;
    if (botData?.recordings?.[0]?.media_shortcuts) {
      const shortcuts = botData.recordings[0].media_shortcuts;
      videoUrl = shortcuts.video?.data?.download_url || null;
      audioUrl = shortcuts.audio?.data?.download_url || null;
      console.log(`[RECALL-NOTES] Extracted media URLs: video=${videoUrl ? 'present' : 'N/A'}, audio=${audioUrl ? 'present' : 'N/A'}`);
    }
    
    const enrichedPayload = botData ? {
      ...rawPayload,
      data: {
        ...rawPayload?.data,
        bot: botData,
        recordings: botData.recordings,
        media_shortcuts: botData.recordings?.[0]?.media_shortcuts,
        // Store video/audio URLs at the top level for easy access
        video_url: videoUrl,
        audio_url: audioUrl,
        recording_url: videoUrl, // Alias for compatibility
        // Store bot metadata including calendar_meetings for title extraction
        bot_metadata: {
          meeting_metadata: botData.meeting_metadata || {},
          calendar_meetings: botData.calendar_meetings || [],
        },
        calendar_meetings: botData.calendar_meetings || [],
      },
    } : rawPayload;

    const meetingUrlFromPayload =
      enrichedPayload?.data?.meeting_url || enrichedPayload?.meeting_url;
    const meetingMetadata = extractMeetingMetadata({
      meetingUrl: meetingUrlFromPayload,
      calendarMeetingUrl: calendarEvent?.meetingUrl,
    });

    // Persist meetingUrl back into payload to keep rawPayload consistent
    const payloadWithMeetingUrl = {
      ...enrichedPayload,
      data: {
        ...enrichedPayload?.data,
        meeting_url:
          meetingUrlFromPayload || normalizeMeetingUrl(calendarEvent?.meetingUrl),
      },
    };

    const artifactDefaults = {
      recallEventId: effectiveRecallEventId,
      recallBotId,
      calendarEventId: calendarEvent?.id || null,
      userId: calendarEvent?.Calendar?.userId || calendarEvent?.userId || null,
      eventType: event,
      status: statusCode === "done" ? "completed" : "received",
      ...meetingMetadata,
    };

    if (artifact) {
      // Merge payloads to preserve all data across multiple webhook calls
      const mergedPayload = {
        ...artifact.rawPayload,
        ...payloadWithMeetingUrl,
        data: {
          ...artifact.rawPayload?.data,
          ...payloadWithMeetingUrl?.data,
        },
      };
      await artifact.update({
        ...artifactDefaults,
        rawPayload: mergedPayload,
      });
      console.log(`[RECALL-NOTES] Updated existing artifact ${artifact.id}`);
    } else {
      // Generate unique readable ID based on meeting start time or current time
      const artifactId = uuidv4();
      const meetingDate = calendarEvent?.startTime 
        ? new Date(calendarEvent.startTime)
        : (enrichedPayload?.data?.start_time ? new Date(enrichedPayload.data.start_time) : new Date());
      
      // Check uniqueness function for readableId
      const checkUnique = async (id) => {
        const existing = await db.MeetingArtifact.findOne({
          where: { readableId: id },
        });
        return !existing;
      };
      
      const readableId = await generateUniqueReadableMeetingId(meetingDate, checkUnique, artifactId);
      
      artifact = await db.MeetingArtifact.create({
        id: artifactId,
        ...artifactDefaults,
        readableId: readableId,
        rawPayload: payloadWithMeetingUrl,
      });
      console.log(`[RECALL-NOTES] Created new artifact ${artifact.id} with readableId ${readableId}`);
    }

    // Handle transcript segments (streaming or final)
    const segments = extractTranscriptSegments(rawPayload, event);
    if (segments.length > 0) {
      // For streaming events (partial_data), we APPEND chunks rather than replacing.
      // For final events (transcript.data, transcript.done), we can replace.
      const isFinalTranscript =
        event === "transcript.data" ||
        event === "transcript.done" ||
        event === "notes";

      if (isFinalTranscript) {
        // Replace all chunks with final transcript
        await db.MeetingTranscriptChunk.destroy({
          where: { meetingArtifactId: artifact.id },
        });
        console.log(
          `[RECALL-NOTES] Cleared existing chunks for final transcript (artifact ${artifact.id})`
        );
      }

      // Get current max sequence for this artifact (for appending)
      let maxSequence = 0;
      if (!isFinalTranscript) {
        const lastChunk = await db.MeetingTranscriptChunk.findOne({
          where: { meetingArtifactId: artifact.id },
          order: [["sequence", "DESC"]],
        });
        maxSequence = lastChunk ? lastChunk.sequence + 1 : 0;
      }

      const chunksToCreate = segments.map((segment, idx) => ({
        id: uuidv4(),
        meetingArtifactId: artifact.id,
        userId: artifact.userId,
        calendarEventId: artifact.calendarEventId,
        sequence: isFinalTranscript ? segment.sequence : maxSequence + idx,
        startTimeMs: segment.startTimeMs,
        endTimeMs: segment.endTimeMs,
        speaker: segment.speaker,
        text: segment.text,
      }));

      await db.MeetingTranscriptChunk.bulkCreate(chunksToCreate, {
        validate: true,
      });

      console.log(
        `[RECALL-NOTES] Persisted ${chunksToCreate.length} transcript chunks (artifact ${artifact.id}, event=${event})`
      );
    }

    // On completion events, check if we have transcript chunks.
    // If not, fetch transcript from Recall API as a fallback.
    const isCompletionEvent =
      event === "transcript.done" ||
      event === "recording.done" ||
      event === "notes";

    if (isCompletionEvent && recallBotId) {
      const existingChunks = await db.MeetingTranscriptChunk.count({
        where: { meetingArtifactId: artifact.id },
      });

      if (existingChunks === 0) {
        console.log(
          `[RECALL-NOTES] No transcript chunks found for artifact ${artifact.id}, fetching from Recall API...`
        );
        try {
          const transcriptData = await Recall.getBotTranscript(recallBotId);
          const fallbackSegments = extractTranscriptSegments(
            { data: transcriptData },
            "transcript.data"
          );

          if (fallbackSegments.length > 0) {
            const fallbackChunks = fallbackSegments.map((segment, idx) => ({
              id: uuidv4(),
              meetingArtifactId: artifact.id,
              userId: artifact.userId,
              calendarEventId: artifact.calendarEventId,
              sequence: idx,
              startTimeMs: segment.startTimeMs,
              endTimeMs: segment.endTimeMs,
              speaker: segment.speaker,
              text: segment.text,
            }));

            await db.MeetingTranscriptChunk.bulkCreate(fallbackChunks, {
              validate: true,
            });

            console.log(
              `[RECALL-NOTES] Fallback fetch: persisted ${fallbackChunks.length} transcript chunks from Recall API`
            );
          } else {
            console.log(
              `[RECALL-NOTES] Fallback fetch: Recall API returned no transcript segments`
            );
          }
        } catch (err) {
          console.warn(
            `[RECALL-NOTES] Fallback fetch failed for bot ${recallBotId}: ${err.message}`
          );
        }
      }
    }

    // Enqueue enrichment ONLY on completion events (not on every partial)
    const shouldEnrich =
      event === "transcript.done" ||
      event === "recording.done" ||
      event === "notes" ||
      event === "bot.status_change";

    if (shouldEnrich) {
      console.log(
        `[RECALL-NOTES] Enqueueing enrichment for artifact ${artifact.id} (event=${event})`
      );
      backgroundQueue.add("meeting.enrich", {
        meetingArtifactId: artifact.id,
      });
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("[RECALL-NOTES] Failed to handle webhook:", err);
    return res.sendStatus(500);
  }
};
