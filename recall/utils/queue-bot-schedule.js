import { backgroundQueue } from "../queue.js";

/**
 * Queue a bot scheduling job with deduplication.
 * Uses jobId to prevent duplicate jobs for the same event.
 * 
 * @param {string} recallEventId - The Recall event ID
 * @param {string} calendarId - The calendar ID (optional, for logging)
 * @param {Object} options - Additional options
 * @param {boolean} options.forceReschedule - If true, removes any existing job and creates a new one (for settings changes)
 * @param {boolean} options.isRetry - If true, processor uses a unique deduplication key so Recall creates a new bot (e.g. meeting started late)
 * @returns {Promise} The queued job
 */
export async function queueBotScheduleJob(recallEventId, calendarId = null, options = {}) {
  const { forceReschedule = false, isRetry = false } = options;
  
  // Use jobId to prevent duplicate bot scheduling jobs for the same event
  const jobId = `bot-schedule-${recallEventId}`;
  
  // #region agent log
  fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'utils/queue-bot-schedule.js:queue_start',message:'Queueing bot schedule job',data:{recallEventId,calendarId,forceReschedule,jobId},timestamp:Date.now(),hypothesisId:'H4'})}).catch(()=>{});
  // #endregion
  
  // If forceReschedule is true, remove any existing job first
  if (forceReschedule) {
    try {
      const existingJob = await backgroundQueue.getJob(jobId);
      if (existingJob) {
        // #region agent log
        fetch('http://127.0.0.1:7250/ingest/bf0206c3-6e13-4499-92a3-7fb2b7527fcf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'utils/queue-bot-schedule.js:removing_existing',message:'Removing existing job for reschedule',data:{recallEventId,jobId,existingJobState:await existingJob.getState()},timestamp:Date.now(),sessionId:'debug-session',runId:'settings-change',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        await existingJob.remove();
        console.log(`[BOT-SCHEDULE] Removed existing job ${jobId} for reschedule`);
      }
    } catch (err) {
      // Ignore errors when removing - job might not exist
      console.log(`[BOT-SCHEDULE] Could not remove existing job ${jobId}: ${err.message}`);
    }
  }
  
  // Check if job already exists before attempting to add
  try {
    const existingJob = await backgroundQueue.getJob(jobId);
    if (existingJob) {
      const jobState = await existingJob.getState();
      if (jobState === 'failed') {
        await existingJob.remove();
        console.log(`[BOT-SCHEDULE] Removed failed job ${jobId} to allow retry`);
      } else {
        console.log(`[BOT-SCHEDULE] ⚠️  Duplicate job attempt prevented: eventId=${recallEventId} jobId=${jobId} existingState=${jobState}`);
        return existingJob;
      }
    }
  } catch (err) {
    // Job doesn't exist, continue to add it
  }
  
  try {
    const job = await backgroundQueue.add(
      "calendarevent.update_bot_schedule",
      {
        calendarId,
        recallEventId,
        isRetry,
      },
      {
        jobId, // This prevents duplicate jobs - if a job with this ID exists, it won't be added again
        removeOnComplete: true,
        removeOnFail: false,
      }
    );
    
    console.log(`[BOT-SCHEDULE] ✅ Job queued successfully: eventId=${recallEventId} jobId=${jobId} queueJobId=${job?.id}`);
    
    // #region agent log
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'utils/queue-bot-schedule.js:job_added',message:'Job added successfully',data:{recallEventId,jobId,jobIdResult:job?.id},timestamp:Date.now(),hypothesisId:'H4'})}).catch(()=>{});
    // #endregion
    
    return job;
  } catch (err) {
    // If job already exists, that's okay - it means a bot scheduling job is already queued
    if (err.message?.includes("already exists") || err.code === "DUPLICATE_JOB") {
      // #region agent log
      fetch('http://127.0.0.1:7250/ingest/bf0206c3-6e13-4499-92a3-7fb2b7527fcf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'utils/queue-bot-schedule.js:job_exists',message:'Job already exists',data:{recallEventId,jobId,errorMessage:err.message},timestamp:Date.now(),sessionId:'debug-session',runId:'settings-change',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      console.log(`[BOT-SCHEDULE] ⚠️  Duplicate job prevented (caught in add): eventId=${recallEventId} jobId=${jobId} error=${err.message}`);
      // Return the existing job
      return await backgroundQueue.getJob(jobId);
    }
    throw err;
  }
}

/**
 * Queue a bot deletion job with deduplication.
 * Uses jobId to prevent duplicate jobs for the same event.
 * 
 * @param {string} recallEventId - The Recall event ID
 * @returns {Promise} The queued job
 */
export async function queueBotDeleteJob(recallEventId) {
  // Use jobId to prevent duplicate bot deletion jobs for the same event
  const jobId = `bot-delete-${recallEventId}`;
  
  // Check if job already exists before attempting to add
  try {
    const existingJob = await backgroundQueue.getJob(jobId);
    if (existingJob) {
      const jobState = await existingJob.getState();
      if (jobState === 'failed') {
        await existingJob.remove();
        console.log(`[BOT-DELETE] Removed failed job ${jobId} to allow retry`);
      } else {
        console.log(`[BOT-DELETE] ⚠️  Duplicate job attempt prevented: eventId=${recallEventId} jobId=${jobId} existingState=${jobState}`);
        return existingJob;
      }
    }
  } catch (err) {
    // Job doesn't exist, continue to add it
  }
  
  try {
    const job = await backgroundQueue.add(
      "calendarevent.delete_bot",
      {
        recallEventId,
      },
      {
        jobId, // This prevents duplicate jobs - if a job with this ID exists, it won't be added again
        removeOnComplete: true,
        removeOnFail: false,
      }
    );
    
    console.log(`[BOT-DELETE] ✅ Job queued successfully: eventId=${recallEventId} jobId=${jobId} queueJobId=${job?.id}`);
    return job;
  } catch (err) {
    // If job already exists, that's okay - it means a bot deletion job is already queued
    if (err.message?.includes("already exists") || err.code === "DUPLICATE_JOB") {
      console.log(`[BOT-DELETE] ⚠️  Duplicate job prevented (caught in add): eventId=${recallEventId} jobId=${jobId} error=${err.message}`);
      // Return the existing job
      return await backgroundQueue.getJob(jobId);
    }
    throw err;
  }
}

