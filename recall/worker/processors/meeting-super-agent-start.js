import { Op } from "sequelize";
import db from "../../db.js";
import { backgroundQueue } from "../../queue.js";
import AssemblyAI from "../../services/assemblyai/index.js";

const SUPER_AGENT_MIN_TRANSCRIPT_CHARS = 20;

/**
 * Before submitting a new AssemblyAI job, reuse a transcript for this meeting if the API
 * already has it completed or still processing (avoids duplicate spend when the app showed error).
 */
async function tryReuseExistingAssemblyTranscript({
  analysis,
  meetingArtifactId,
  recordingUrl,
  config,
}) {
  const priors = await db.MeetingSuperAgentAnalysis.findAll({
    where: {
      meetingArtifactId,
      assemblyTranscriptId: { [Op.ne]: null },
      id: { [Op.ne]: analysis.id },
    },
    order: [["createdAt", "DESC"]],
    limit: 20,
  });

  const priorByTranscriptId = new Map();
  for (const p of priors) {
    const tid = p.assemblyTranscriptId;
    if (typeof tid === "string" && tid.trim() && !priorByTranscriptId.has(tid)) {
      priorByTranscriptId.set(tid, p);
    }
  }

  const candidateIds = [];
  const seen = new Set();
  const pushId = (id) => {
    if (typeof id !== "string" || !id.trim() || seen.has(id)) return;
    seen.add(id);
    candidateIds.push(id);
  };
  pushId(analysis.assemblyTranscriptId);
  for (const p of priors) {
    pushId(p.assemblyTranscriptId);
  }

  for (const transcriptId of candidateIds) {
    let remote;
    try {
      remote = await AssemblyAI.getTranscript(transcriptId);
    } catch (err) {
      console.warn(
        `[SuperAgent] Could not fetch existing transcript ${transcriptId}:`,
        err?.message || err
      );
      continue;
    }

    const priorRow = priorByTranscriptId.get(transcriptId);
    const assemblyRequest =
      (priorRow?.assemblyRequest && typeof priorRow.assemblyRequest === "object"
        ? priorRow.assemblyRequest
        : null) || { ...config, audio_url: recordingUrl };

    if (remote.status === "queued" || remote.status === "processing") {
      await analysis.update({
        status: "processing",
        assemblyTranscriptId: transcriptId,
        assemblyRequest,
        errorMessage: null,
        processingStage: "transcription",
        assemblyTranscriptStatus: remote.status,
      });
      console.log(
        `[SuperAgent] Reused in-flight AssemblyAI transcript ${transcriptId} for analysis ${analysis.id} (no new submission)`
      );
      return true;
    }

    if (remote.status === "completed") {
      const text = AssemblyAI.getTranscriptPlainText(remote);
      if (text.length >= SUPER_AGENT_MIN_TRANSCRIPT_CHARS) {
        await analysis.update({
          status: "processing",
          assemblyTranscriptId: transcriptId,
          assemblyRequest,
          errorMessage: null,
          processingStage: "analysis",
          assemblyTranscriptStatus: "completed",
        });
        await backgroundQueue.add(
          "meeting.super_agent.complete",
          { analysisId: analysis.id, transcriptId },
          {
            jobId: `super-agent-complete-${analysis.id}`,
            removeOnComplete: true,
            removeOnFail: false,
          }
        );
        console.log(
          `[SuperAgent] Reused completed AssemblyAI transcript ${transcriptId} for analysis ${analysis.id}; queued LLM completion`
        );
        return true;
      }
    }
  }

  return false;
}

function resolvePublicUrl() {
  let publicUrl = process.env.PUBLIC_URL;
  if (!publicUrl && process.env.RAILWAY_PUBLIC_DOMAIN) {
    publicUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  if (!publicUrl && process.env.RAILWAY_STATIC_URL) {
    publicUrl = process.env.RAILWAY_STATIC_URL;
  }
  return publicUrl ? publicUrl.replace(/\/$/, "") : null;
}

function resolveRecordingUrl(artifact) {
  return (
    artifact.archivedRecordingUrl ||
    artifact.rawPayload?.data?.video_url ||
    artifact.rawPayload?.data?.recording_url ||
    artifact.rawPayload?.data?.media_shortcuts?.video_mixed?.data?.download_url ||
    artifact.rawPayload?.data?.media_shortcuts?.video?.data?.download_url ||
    artifact.rawPayload?.data?.media_shortcuts?.audio_mixed?.data?.download_url ||
    artifact.rawPayload?.data?.media_shortcuts?.audio?.data?.download_url ||
    artifact.rawPayload?.data?.audio_url ||
    artifact.sourceRecordingUrl ||
    artifact.rawPayload?.data?.teamsRecordingUrl ||
    artifact.rawPayload?.data?.teams_video_url ||
    artifact.rawPayload?.teamsRecordingUrl ||
    artifact.rawPayload?.data?.sharePointRecordingUrl ||
    null
  );
}

function buildTranscriptionConfig(requestedFeatures = {}, webhookUrl) {
  const config = {
    auto_chapters: true,
    speaker_labels: true,
    iab_categories: !!requestedFeatures.topicDetection,
    content_safety: !!requestedFeatures.contentModeration,
    redact_pii: !!requestedFeatures.piiRedaction,
    filter_profanity: !!requestedFeatures.profanityFiltering,
    sentiment_analysis: !!requestedFeatures.sentimentAnalysis,
  };

  if (webhookUrl) {
    config.webhook_url = webhookUrl;
    if (process.env.ASSEMBLYAI_WEBHOOK_SECRET) {
      config.webhook_auth_header_name =
        process.env.ASSEMBLYAI_WEBHOOK_HEADER_NAME || "x-assemblyai-webhook-secret";
      config.webhook_auth_header_value = process.env.ASSEMBLYAI_WEBHOOK_SECRET;
    }
  }

  if (Array.isArray(requestedFeatures.translateTo) && requestedFeatures.translateTo.length > 0) {
    config.speech_understanding = {
      request: {
        translation: {
          target_languages: requestedFeatures.translateTo,
          formal: true,
          match_original_utterance: true,
        },
      },
    };
  }

  return config;
}

export default async (job) => {
  const { analysisId, meetingArtifactId, requestedFeatures } = job.data;

  // #region agent log - H12: Debug Super Agent processor start
  fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-super-agent-start.js:processor',message:'super_agent_processor_start',data:{analysisId,meetingArtifactId,requestedFeatures},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H12'})}).catch(()=>{});
  // #endregion

  const analysis = await db.MeetingSuperAgentAnalysis.findByPk(analysisId);
  if (!analysis) {
    console.warn(`[SuperAgent] Analysis ${analysisId} not found`);
    return;
  }

  if (analysis.status === "completed") {
    console.log(`[SuperAgent] Analysis ${analysisId} already completed`);
    return;
  }

  const artifact = await db.MeetingArtifact.findByPk(meetingArtifactId, {
    include: [
      {
        model: db.CalendarEvent,
        include: [{ model: db.Calendar }],
      },
    ],
  });

  if (!artifact) {
    await analysis.update({
      status: "error",
      errorMessage: "Meeting artifact not found",
    });
    // #region agent log - H12b: Debug artifact not found
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-super-agent-start.js:processor',message:'super_agent_artifact_not_found',data:{analysisId,meetingArtifactId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H12b'})}).catch(()=>{});
    // #endregion
    return;
  }

  const recordingUrl = resolveRecordingUrl(artifact);
  if (!recordingUrl) {
    await analysis.update({
      status: "error",
      errorMessage: "No recording URL available for analysis",
    });
    // #region agent log - H12c: Debug no recording URL
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-super-agent-start.js:processor',message:'super_agent_no_recording_url',data:{analysisId,artifactId:artifact.id,archivedRecordingUrl:artifact.archivedRecordingUrl?.substring(0,50),sourceRecordingUrl:artifact.sourceRecordingUrl?.substring(0,50),rawPayloadKeys:Object.keys(artifact.rawPayload||{})},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H12c'})}).catch(()=>{});
    // #endregion
    return;
  }

  const publicUrl = resolvePublicUrl();
  if (!publicUrl) {
    await analysis.update({
      status: "error",
      errorMessage: "PUBLIC_URL not configured for AssemblyAI webhooks",
    });
    // #region agent log - H12d: Debug no public URL
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-super-agent-start.js:processor',message:'super_agent_no_public_url',data:{analysisId,PUBLIC_URL:process.env.PUBLIC_URL,RAILWAY_PUBLIC_DOMAIN:process.env.RAILWAY_PUBLIC_DOMAIN,RAILWAY_STATIC_URL:process.env.RAILWAY_STATIC_URL},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H12d'})}).catch(()=>{});
    // #endregion
    return;
  }

  const webhookUrl = `${publicUrl}/webhooks/assemblyai`;
  const features = requestedFeatures || analysis.requestedFeatures || {};
  const config = buildTranscriptionConfig(features, webhookUrl);

  // #region agent log - H12e: Debug before AssemblyAI submission
  fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-super-agent-start.js:processor',message:'super_agent_before_assemblyai_submit',data:{analysisId,recordingUrlPrefix:recordingUrl?.substring(0,80),webhookUrl,features,configKeys:Object.keys(config||{}),hasAssemblyAIKey:!!process.env.ASSEMBLYAI_API_KEY},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H12e'})}).catch(()=>{});
  // #endregion

  try {
    const reused = await tryReuseExistingAssemblyTranscript({
      analysis,
      meetingArtifactId,
      recordingUrl,
      config,
    });
    if (reused) {
      return;
    }

    const { transcript, requestBody } = await AssemblyAI.submitTranscript({
      audioUrl: recordingUrl,
      requestBody: config,
      allowUploadFallback: true,
    });

    await analysis.update({
      status: "processing",
      assemblyTranscriptId: transcript.id,
      assemblyRequest: requestBody,
      errorMessage: null,
      processingStage: "transcription",
      assemblyTranscriptStatus: transcript.status || "queued",
    });

    // Queue a fallback polling job in case the AssemblyAI webhook never fires.
    // The complete processor polls AssemblyAI (up to 240 attempts) and will no-op
    // if the transcript is still queued/processing. When the transcript is done,
    // it proceeds with LLM analysis. The webhook is the fast path; this is the
    // fallback that keeps the analysis from being stuck forever.
    await backgroundQueue.add(
      "meeting.super_agent.complete",
      { analysisId, transcriptId: transcript.id },
      {
        jobId: `super-agent-complete-${analysisId}`,
        removeOnComplete: true,
        removeOnFail: false,
        delay: 60000, // Start polling after 60s
      }
    );

    // #region agent log - H12f: Debug AssemblyAI submission success
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-super-agent-start.js:processor',message:'super_agent_assemblyai_submitted',data:{analysisId,transcriptId:transcript.id,status:'processing'},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H12f'})}).catch(()=>{});
    // #endregion

    console.log(
      `[SuperAgent] Submitted AssemblyAI transcript ${transcript.id} for analysis ${analysis.id}`
    );
  } catch (error) {
    console.error(`[SuperAgent] Failed to submit transcript:`, error);
    // #region agent log - H12g: Debug AssemblyAI submission error
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-super-agent-start.js:processor',message:'super_agent_assemblyai_error',data:{analysisId,error:error?.message,stack:error?.stack?.substring(0,500)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H12g'})}).catch(()=>{});
    // #endregion
    await analysis.update({
      status: "error",
      errorMessage: error?.message || "Failed to submit transcription",
    });
  }
};
