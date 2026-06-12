import db from "../../db.js";
import { backgroundQueue } from "../../queue.js";

/**
 * Periodic enrichment recovery job.
 *
 * Recall webhooks (recording.done, transcript.done) are the primary trigger
 * for enrichment. When a webhook is dropped or never fires, the meeting
 * artifact stays at status: "done" with no MeetingSummary forever.
 *
 * This job runs on a cron and recovers those stuck artifacts by:
 *   1. Finding artifacts with status: "done" and no MeetingSummary
 *   2. Filtering to only those that have transcript chunks (transcription happened)
 *   3. Queuing meeting.enrich for each one with deduplication
 */
export default async (job) => {
  console.log(`[ENRICH-RECOVERY] Starting periodic enrichment recovery...`);

  try {
    const artifacts = await db.MeetingArtifact.findAll({
      include: [
        {
          model: db.MeetingSummary,
          required: false,
        },
      ],
      where: { status: "done" },
      order: [["createdAt", "DESC"]],
    });

    const withoutSummary = artifacts.filter(
      (a) => !a.MeetingSummaries || a.MeetingSummaries.length === 0
    );

    if (withoutSummary.length === 0) {
      console.log(`[ENRICH-RECOVERY] Nothing to recover`);
      return;
    }

    // Check which ones have transcript chunks (avoids dual-hasMany include)
    const artifactIds = withoutSummary.map((a) => a.id);
    const withChunks = await db.MeetingTranscriptChunk.findAll({
      attributes: ["meetingArtifactId"],
      where: {
        meetingArtifactId: { [db.Sequelize.Op.in]: artifactIds },
      },
      group: ["meetingArtifactId"],
      raw: true,
    });
    const idsWithChunks = new Set(withChunks.map((c) => c.meetingArtifactId));
    const stuckArtifacts = withoutSummary.filter((a) =>
      idsWithChunks.has(a.id)
    );

    console.log(
      `[ENRICH-RECOVERY] Found ${artifacts.length} done artifact(s), ${withoutSummary.length} without summary, ${stuckArtifacts.length} stuck (have transcript)`
    );

    if (stuckArtifacts.length === 0) {
      console.log(`[ENRICH-RECOVERY] Nothing to recover`);
      return;
    }

    let recovered = 0;
    for (const artifact of stuckArtifacts) {
      try {
        await backgroundQueue.add(
          "meeting.enrich",
          { meetingArtifactId: artifact.id },
          { jobId: `enrich-${artifact.id}` }
        );
        recovered++;
        console.log(
          `[ENRICH-RECOVERY] Queued enrichment for artifact ${artifact.id.substring(0, 8)}...`
        );
      } catch (err) {
        console.error(
          `[ENRICH-RECOVERY] Failed to queue enrichment for artifact ${artifact.id}:`,
          err?.message || err
        );
      }
    }

    console.log(
      `[ENRICH-RECOVERY] Complete: recovered ${recovered} of ${stuckArtifacts.length} stuck artifact(s)`
    );
  } catch (error) {
    console.error(`[ENRICH-RECOVERY] Error:`, error);
    throw error;
  }
};
