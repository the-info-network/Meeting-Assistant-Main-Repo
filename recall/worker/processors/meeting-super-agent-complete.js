import db from "../../db.js";
import { backgroundQueue } from "../../queue.js";
import AssemblyAI from "../../services/assemblyai/index.js";

/** Poll AssemblyAI while status is queued/processing before treating it as a hard failure. */
const MAX_TRANSCRIPT_POLL_ATTEMPTS = 240;

function tokenize(text) {
  if (!text || typeof text !== "string") return [];
  return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

function scoreOverlap(aTokens, bTokens) {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const setB = new Set(bTokens);
  let score = 0;
  for (const token of aTokens) {
    if (setB.has(token)) score += 1;
  }
  return score;
}

function findBestTimestamp(text, utterances = []) {
  if (!text || !Array.isArray(utterances) || utterances.length === 0) return null;
  const textTokens = tokenize(text);
  let best = { score: 0, start: null };

  for (const utterance of utterances) {
    const utteranceTokens = tokenize(utterance.text || "");
    const score = scoreOverlap(textTokens, utteranceTokens);
    if (score > best.score) {
      best = { score, start: utterance.start };
    }
  }

  if (!best.start || best.score === 0) return null;
  return Math.max(0, Math.floor(best.start / 1000));
}

function attachTimestamps(items, utterances) {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    if (!item || typeof item !== "object") return item;
    if (typeof item.timestamp_seconds === "number") return item;
    const text =
      item.summary ||
      item.title ||
      item.task ||
      item.action ||
      item.decision ||
      item.paraphrase ||
      item.insight ||
      item.description ||
      "";
    const ts = findBestTimestamp(text, utterances);
    if (ts === null) return item;
    return { ...item, timestamp_seconds: ts };
  });
}

export default async (job) => {
  const { analysisId, transcriptId, transcriptPollAttempt = 0 } = job.data;

  // #region agent log - H15: Debug Super Agent complete processor start
  fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-super-agent-complete.js',message:'super_agent_complete_start',data:{analysisId,transcriptId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H15'})}).catch(()=>{});
  // #endregion

  const analysis = analysisId
    ? await db.MeetingSuperAgentAnalysis.findByPk(analysisId)
    : await db.MeetingSuperAgentAnalysis.findOne({
        where: { assemblyTranscriptId: transcriptId },
        order: [["createdAt", "DESC"]],
      });

  if (!analysis) {
    console.warn(`[SuperAgent] Analysis not found for transcript ${transcriptId}`);
    return;
  }

  if (analysis.status === "completed") {
    console.log(`[SuperAgent] Analysis ${analysis.id} already completed`);
    return;
  }

  /** Set before LLM step so catch can persist AssemblyAI chapters if the LLM fails. */
  let transcriptSnapshot = null;

  try {
    const transcript = await AssemblyAI.getTranscript(
      analysis.assemblyTranscriptId || transcriptId
    );

    if (transcript.status === "error") {
      await analysis.update({
        status: "error",
        errorMessage: transcript.error || "AssemblyAI transcription failed",
        assemblyResult: transcript,
        processingStage: null,
        assemblyTranscriptStatus: "error",
      });
      return;
    }

    if (transcript.status === "queued" || transcript.status === "processing") {
      const nextAttempt = transcriptPollAttempt + 1;
      if (nextAttempt > MAX_TRANSCRIPT_POLL_ATTEMPTS) {
        await analysis.update({
          status: "error",
          errorMessage:
            "Transcription is taking longer than expected. Wait a few minutes and use Retry, or check the recording in AssemblyAI.",
          processingStage: null,
          assemblyTranscriptStatus: transcript.status,
        });
        console.warn(
          `[SuperAgent] Transcript ${analysis.assemblyTranscriptId || transcriptId} still ${transcript.status} after ${MAX_TRANSCRIPT_POLL_ATTEMPTS} polls`
        );
        return;
      }

      await analysis.update({
        status: "processing",
        processingStage: "transcription",
        assemblyTranscriptStatus: transcript.status,
        errorMessage: null,
      });

      const delayMs = Math.min(20000, 3000 + nextAttempt * 450);
      await backgroundQueue.add(
        "meeting.super_agent.complete",
        {
          analysisId: analysis.id,
          transcriptId: analysis.assemblyTranscriptId || transcriptId,
          transcriptPollAttempt: nextAttempt,
        },
        {
          delay: delayMs,
          removeOnComplete: true,
          removeOnFail: false,
        }
      );
      console.log(
        `[SuperAgent] Transcript ${analysis.assemblyTranscriptId || transcriptId} status=${transcript.status}; poll ${nextAttempt}/${MAX_TRANSCRIPT_POLL_ATTEMPTS} in ${delayMs}ms`
      );
      return;
    }

    if (transcript.status !== "completed") {
      await analysis.update({
        status: "error",
        errorMessage: `Unexpected AssemblyAI transcript status: ${transcript.status}. Try Retry or contact support.`,
        assemblyResult: transcript,
        processingStage: null,
        assemblyTranscriptStatus: transcript.status,
      });
      console.warn(
        `[SuperAgent] Transcript ${analysis.assemblyTranscriptId || transcriptId} expected completed, got ${transcript.status}`
      );
      return;
    }

    await analysis.update({
      processingStage: "analysis",
      assemblyTranscriptStatus: "completed",
      errorMessage: null,
    });

    const transcriptText = AssemblyAI.getTranscriptPlainText(transcript);
    if (!transcriptText || transcriptText.length < 20) {
      await analysis.update({
        status: "error",
        errorMessage:
          "AssemblyAI returned no usable transcript text. The recording URL may be expired, blocked, silent, or unreadable by AssemblyAI.",
        assemblyResult: transcript,
        processingStage: null,
      });
      console.warn(
        `[SuperAgent] Empty or too-short transcript for analysis ${analysis.id} (len=${transcriptText?.length || 0})`
      );
      return;
    }

    transcriptSnapshot = transcript;

    const artifact = await db.MeetingArtifact.findByPk(analysis.meetingArtifactId, {
      include: [
        {
          model: db.CalendarEvent,
          include: [{ model: db.Calendar }],
        },
      ],
    });

    const metadata = {
      title:
        artifact?.CalendarEvent?.title ||
        artifact?.title ||
        artifact?.rawPayload?.title ||
        artifact?.rawPayload?.data?.title ||
        "Meeting",
      participants:
        artifact?.rawPayload?.data?.participants ||
        artifact?.rawPayload?.data?.attendees ||
        [],
      startTime:
        artifact?.CalendarEvent?.startTime ||
        artifact?.rawPayload?.data?.start_time ||
        null,
    };

    const summaryResult = await AssemblyAI.generateSuperAgentSummary({
      transcriptText,
      metadata,
      chapters: transcript.chapters || [],
    });

    const utterances = transcript.utterances || [];
    const highlights = attachTimestamps(summaryResult.highlights || [], utterances);
    const decisions = attachTimestamps(summaryResult.decisions || [], utterances);
    const actionItems = attachTimestamps(summaryResult.actionItems || [], utterances);

    await analysis.update({
      status: "completed",
      assemblyResult: transcript,
      detailedSummary: summaryResult.detailedSummary || "",
      actionItems,
      decisions,
      highlights,
      chapters: transcript.chapters || [],
      sentiment: transcript.sentiment_analysis_results || null,
      topics: transcript.iab_categories_result || null,
      contentSafety: transcript.content_safety_labels || null,
      translation: transcript.translated_texts || null,
      piiRedactionApplied: !!transcript.redact_pii,
      errorMessage: null,
      processingStage: null,
      assemblyTranscriptStatus: null,
    });

    // #region agent log - H15b: Debug Super Agent complete success
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-super-agent-complete.js',message:'super_agent_complete_success',data:{analysisId:analysis.id,hasDetailedSummary:!!summaryResult.detailedSummary,actionItemsCount:actionItems?.length||0,decisionsCount:decisions?.length||0,highlightsCount:highlights?.length||0,chaptersCount:transcript.chapters?.length||0,hasTopics:!!transcript.iab_categories_result},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H15b'})}).catch(()=>{});
    // #endregion

    console.log(`[SuperAgent] Analysis ${analysis.id} completed`);
  } catch (error) {
    console.error(`[SuperAgent] Failed to complete analysis ${analysis?.id}:`, error);
    // #region agent log - H15c: Debug Super Agent complete error
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'meeting-super-agent-complete.js',message:'super_agent_complete_error',data:{analysisId:analysis?.id,error:error?.message,stack:error?.stack?.substring(0,500)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H15c'})}).catch(()=>{});
    // #endregion
    const errorPatch = {
      status: "error",
      errorMessage: error?.message || "Failed to complete Super Agent analysis",
      processingStage: null,
    };
    if (
      transcriptSnapshot &&
      transcriptSnapshot.status === "completed" &&
      Array.isArray(transcriptSnapshot.chapters) &&
      transcriptSnapshot.chapters.length > 0
    ) {
      errorPatch.chapters = transcriptSnapshot.chapters;
      errorPatch.assemblyResult = transcriptSnapshot;
    }
    await analysis.update(errorPatch);
  }
};
