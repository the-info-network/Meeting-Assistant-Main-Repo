/**
 * Worker processor for ingesting external meetings (not on user's calendar)
 *
 * Supports:
 * - meetingUrl: Teams meeting URL → try Graph API with user's Microsoft calendars
 * - recordingUrl: Direct recording URL → create artifact, queue Super Agent
 */

import db from "../../db.js";
import { backgroundQueue } from "../../queue.js";
import {
  fetchTeamsDataByMeetingUrl,
  parseVTTTranscript,
} from "../../services/microsoft-graph/index.js";
import { extractMeetingMetadata } from "../../utils/meeting-metadata-extractor.js";
import { generateUniqueReadableMeetingId } from "../../utils/meeting-id.js";

export default async (job) => {
  const { meetingUrl, recordingUrl, userId, title } = job.data;

  console.log(`[Ingest External] Starting: meetingUrl=${!!meetingUrl}, recordingUrl=${!!recordingUrl}, userId=${userId}`);

  try {
    if (meetingUrl) {
      await processTeamsUrl(meetingUrl, userId, title);
    } else if (recordingUrl) {
      await processRecordingUrl(recordingUrl, userId, title);
    } else {
      console.warn(`[Ingest External] No meetingUrl or recordingUrl provided`);
    }
  } catch (error) {
    console.error(`[Ingest External] Error:`, error);
    throw error;
  }
};

async function processTeamsUrl(meetingUrl, userId, title) {
  const calendars = await db.Calendar.findAll({
    where: { userId, platform: "microsoft_outlook" },
    include: [{ model: db.User, attributes: ["id", "email"] }],
  });

  if (calendars.length === 0) {
    console.warn(`[Ingest External] No Microsoft calendars for user ${userId}`);
    return;
  }

  let transcriptData = null;
  let recordingMetadata = null;
  let usedCalendar = null;

  for (const calendar of calendars) {
    try {
      const result = await fetchTeamsDataByMeetingUrl(meetingUrl, calendar);
      if (result.transcriptData || result.recordingMetadata) {
        transcriptData = result.transcriptData;
        recordingMetadata = result.recordingMetadata;
        usedCalendar = calendar;
        console.log(`[Ingest External] Success with calendar ${calendar.id} (${calendar.email})`);
        break;
      }
    } catch (e) {
      console.warn(`[Ingest External] Calendar ${calendar.id} failed: ${e.message}`);
    }
  }

  if (!transcriptData && !recordingMetadata) {
    console.warn(`[Ingest External] Could not access Teams meeting. User may need to be a participant.`);
    return;
  }

  const meetingMetadata = extractMeetingMetadata({
    meetingUrl,
    calendarMeetingUrl: meetingUrl,
  });

  let teamsRecordingUrl = null;
  let teamsRecordingId = null;
  if (recordingMetadata?.recordings?.length > 0) {
    const r = recordingMetadata.recordings[0];
    teamsRecordingUrl =
      r.contentDownloadUrl || r.downloadUrl || r.recordingContentUrl || r.recordingUrl || null;
    teamsRecordingId = r.id || r.recordingId || null;
  }

  let transcriptChunks = [];
  if (transcriptData?.content) {
    transcriptChunks = parseVTTTranscript(transcriptData.content);
  }

  const checkUnique = async (id) => {
    const existing = await db.MeetingArtifact.findOne({ where: { readableId: id } });
    return !existing;
  };
  const readableId = await generateUniqueReadableMeetingId(new Date(), checkUnique);

  const artifactPayload = {
    recallEventId: null,
    calendarEventId: null,
    userId,
    ownerUserId: userId,
    eventType: "teams_url_ingest",
    status: "done",
    ...meetingMetadata,
    meetingUrl,
    sourceRecordingUrl: teamsRecordingUrl,
    title: title || "Imported Teams meeting",
    rawPayload: {
      source: "microsoft_teams",
      meetingUrl,
      title: title || "Imported Teams meeting",
      transcriptId: transcriptData?.transcriptId || null,
      recordingId: teamsRecordingId || null,
      teamsRecordingUrl,
      teamsRecordingMetadata: recordingMetadata?.recordings || null,
      transcript: transcriptChunks,
    },
    readableId,
  };

  const artifact = await db.MeetingArtifact.create(artifactPayload);

  if (transcriptChunks.length > 0) {
    await Promise.all(
      transcriptChunks.map((chunk, i) =>
        db.MeetingTranscriptChunk.create({
          meetingArtifactId: artifact.id,
          calendarEventId: null,
          userId,
          sequence: chunk.sequence ?? i,
          startTimeMs: chunk.startTimeMs,
          endTimeMs: chunk.endTimeMs,
          speaker: chunk.speaker,
          text: chunk.text,
        })
      )
    );
    await backgroundQueue.add("meeting.enrich", { meetingArtifactId: artifact.id });
    console.log(`[Ingest External] Created artifact ${artifact.id}, queued enrichment`);
  } else if (teamsRecordingUrl && process.env.ASSEMBLYAI_API_KEY) {
    await queueSuperAgent(artifact.id, userId);
    console.log(`[Ingest External] Created artifact ${artifact.id}, queued Super Agent (no transcript)`);
  } else {
    console.log(`[Ingest External] Created artifact ${artifact.id} (no transcript, no recording URL for Super Agent)`);
  }
}

async function processRecordingUrl(recordingUrl, userId, title) {
  const meetingMetadata = extractMeetingMetadata({
    meetingUrl: recordingUrl,
    calendarMeetingUrl: recordingUrl,
  });

  const checkUnique = async (id) => {
    const existing = await db.MeetingArtifact.findOne({ where: { readableId: id } });
    return !existing;
  };
  const readableId = await generateUniqueReadableMeetingId(new Date(), checkUnique);

  const artifact = await db.MeetingArtifact.create({
    recallEventId: null,
    calendarEventId: null,
    userId,
    ownerUserId: userId,
    eventType: "recording_url_ingest",
    status: "done",
    ...meetingMetadata,
    meetingUrl: recordingUrl,
    sourceRecordingUrl: recordingUrl,
    title: title || "Imported recording",
    rawPayload: {
      source: "recording_url",
      recordingUrl,
      title: title || "Imported recording",
    },
    readableId,
  });

  if (process.env.ASSEMBLYAI_API_KEY) {
    await queueSuperAgent(artifact.id, userId);
    console.log(`[Ingest External] Created artifact ${artifact.id}, queued Super Agent`);
  } else {
    console.log(`[Ingest External] Created artifact ${artifact.id} (AssemblyAI not configured)`);
  }
}

async function queueSuperAgent(meetingArtifactId, userId) {
  const calendar = await db.Calendar.findOne({
    where: { userId },
    order: [["id", "ASC"]],
  });

  const enableSuperAgent = calendar?.enableSuperAgent ?? process.env.SUPER_AGENT_ENABLED === "true";
  if (!enableSuperAgent) {
    console.log(`[Ingest External] Super Agent not enabled for user, skipping`);
    return;
  }

  const analysis = await db.MeetingSuperAgentAnalysis.create({
    meetingArtifactId,
    userId,
    status: "queued",
    requestedFeatures: {},
    processingStage: "queued",
  });

  await backgroundQueue.add(
    "meeting.super_agent.start",
    {
      analysisId: analysis.id,
      meetingArtifactId,
      userId,
      requestedFeatures: {},
    },
    {
      jobId: `super-agent-start-${analysis.id}`,
      removeOnComplete: true,
      removeOnFail: false,
    }
  );
}
