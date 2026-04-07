import db from "../../db.js";
import { backgroundQueue } from "../../queue.js";

function isValidSecret(req) {
  const expected = process.env.ASSEMBLYAI_WEBHOOK_SECRET;
  if (!expected) return true;
  const headerName =
    (process.env.ASSEMBLYAI_WEBHOOK_HEADER_NAME || "x-assemblyai-webhook-secret").toLowerCase();
  const received = req.headers[headerName];
  return typeof received === "string" && received === expected;
}

export default async (req, res) => {
  // #region agent log - H14: Debug AssemblyAI webhook received
  fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'webhooks/assemblyai.js',message:'assemblyai_webhook_received',data:{transcriptId:req.body?.id,status:req.body?.status,hasError:!!req.body?.error},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H14'})}).catch(()=>{});
  // #endregion

  // #region agent log - H3: Webhook secret validation result (no secrets)
  try {
    const expectedConfigured = !!process.env.ASSEMBLYAI_WEBHOOK_SECRET;
    const headerName =
      (process.env.ASSEMBLYAI_WEBHOOK_HEADER_NAME || "x-assemblyai-webhook-secret").toLowerCase();
    const received = req.headers?.[headerName];
    const receivedPresent = typeof received === "string" && received.length > 0;
    const valid = isValidSecret(req);
    fetch('http://127.0.0.1:7250/ingest/bf0206c3-6e13-4499-92a3-7fb2b7527fcf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'webhooks/assemblyai.js',message:'assemblyai_webhook_auth',data:{expectedConfigured,headerName,receivedPresent,valid,transcriptId:req.body?.id||null,status:req.body?.status||null},timestamp:Date.now(),sessionId:'debug-session',runId:'pre-fix',hypothesisId:'H3'})}).catch(()=>{});
  } catch (_) {}
  // #endregion

  if (!isValidSecret(req)) {
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  const transcriptId = req.body?.id;
  const status = req.body?.status;

  if (!transcriptId) {
    return res.status(400).json({ error: "Missing transcript id" });
  }

  try {
    const analysis = await db.MeetingSuperAgentAnalysis.findOne({
      where: { assemblyTranscriptId: transcriptId },
      order: [["createdAt", "DESC"]],
    });

    // #region agent log - H14b: Debug AssemblyAI webhook analysis lookup
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'webhooks/assemblyai.js',message:'assemblyai_webhook_analysis_lookup',data:{transcriptId,status,foundAnalysis:!!analysis,analysisId:analysis?.id,currentStatus:analysis?.status},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H14b'})}).catch(()=>{});
    // #endregion

    if (!analysis) {
      return res.sendStatus(204);
    }

    if (status === "error") {
      await analysis.update({
        status: "error",
        errorMessage: req.body?.error || "AssemblyAI transcription failed",
        processingStage: null,
        assemblyTranscriptStatus: "error",
      });
      return res.sendStatus(200);
    }

    if (status !== "completed") {
      return res.sendStatus(200);
    }

    await analysis.update({
      processingStage: "analysis",
      assemblyTranscriptStatus: "completed",
      errorMessage: null,
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

    // #region agent log - H14c: Debug AssemblyAI webhook job queued
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'webhooks/assemblyai.js',message:'assemblyai_webhook_job_queued',data:{transcriptId,analysisId:analysis.id,jobId:`super-agent-complete-${analysis.id}`},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H14c'})}).catch(()=>{});
    // #endregion

    return res.sendStatus(200);
  } catch (error) {
    console.error("[AssemblyAI Webhook] Failed:", error);
    return res.sendStatus(500);
  }
};
