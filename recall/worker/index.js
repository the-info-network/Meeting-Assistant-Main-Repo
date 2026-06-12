import dotenv from "dotenv";
import consoleStamp from "console-stamp";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { connect as connectDb } from "../db.js";
import { backgroundQueue } from "../queue.js";
import Recall from "../services/recall/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Setup file logging to debug.log
const debugLogPath = path.join(__dirname, "..", "debug.log");
const debugLogStream = fs.createWriteStream(debugLogPath, { flags: "a" });

// Enhanced logging function that writes to both console and debug.log
const telemetryLog = (level, message, data = {}) => {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...data,
    pid: process.pid,
    env: process.env.NODE_ENV || "development",
  };
  
  const logLine = JSON.stringify(logEntry) + "\n";
  debugLogStream.write(logLine);
  
  // Also log to console with appropriate level
  const consoleMessage = `[${level}] ${message}${Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : ""}`;
  if (level === "ERROR") {
    console.error(consoleMessage);
  } else if (level === "WARN") {
    console.warn(consoleMessage);
  } else {
    console.log(consoleMessage);
  }
};

import calendarWebhooksSave from "./processors/calendar-webhooks-save.js";
import calendarEventsUpdateAutorecord from "./processors/calendar-events-update-autorecord.js";
import calendarEventUpdateBotSchedule from "./processors/calendar-event-update-bot-schedule.js";
import calendarEventDeleteBot from './processors/calendar-event-delete-bot.js';
import recallCalendarUpdate from "./processors/recall-calendar-update.js";
import recallCalendarSyncEvents from "./processors/recall-calendar-sync-events.js";
import meetingEnrich from "./processors/meeting-enrich.js";
import meetingEmbedChunks from "./processors/meeting-embed-chunks.js";
import publishingDispatch from "./processors/publishing-dispatch.js";
import periodicCalendarSync from "./processors/periodic-calendar-sync.js";
import checkCalendarConnections from "./processors/check-calendar-connections.js";
import teamsRecordingIngest from "./processors/teams-recording-ingest.js";
import meetingIngestExternal from "./processors/meeting-ingest-external.js";
import recordingArchive from "./processors/recording-archive.js";
import meetingSuperAgentStart from "./processors/meeting-super-agent-start.js";
import meetingSuperAgentComplete from "./processors/meeting-super-agent-complete.js";
import periodicEnrichmentRecovery from "./processors/periodic-enrichment-recovery.js";

dotenv.config();
consoleStamp(console);

telemetryLog("INFO", "Worker startup initiated", {
  debugLogPath,
  nodeVersion: process.version,
  platform: process.platform,
});

console.log("🚀 Starting recall worker...");
console.log(`📋 Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`🔗 Redis URL: ${process.env.REDIS_URL ? process.env.REDIS_URL.replace(/:[^:@]+@/, ':****@') : 'NOT SET'}`);
console.log(`💾 Database: ${process.env.DATABASE_URL ? 'PostgreSQL (configured)' : 'NOT SET (DATABASE_URL required)'}`);
console.log(`📝 Debug log: ${debugLogPath}`);

telemetryLog("INFO", "Environment configuration", {
  nodeEnv: process.env.NODE_ENV || "development",
  redisUrlConfigured: !!process.env.REDIS_URL,
  databaseUrlConfigured: !!process.env.DATABASE_URL,
  publicUrl: process.env.PUBLIC_URL || "not-set",
});

// setup db & recall service
console.log("📦 Connecting to database...");
const dbStartTime = Date.now();
try {
  await connectDb();
  const dbConnectTime = Date.now() - dbStartTime;
  console.log("✅ Database connected");
  telemetryLog("INFO", "Database connection established", {
    connectionTimeMs: dbConnectTime,
    databaseType: "PostgreSQL",
  });
} catch (error) {
  telemetryLog("ERROR", "Database connection failed", {
    error: error.message,
    stack: error.stack,
  });
  throw error;
}

console.log("🔧 Initializing Recall service...");
const recallStartTime = Date.now();
try {
  Recall.initialize();
  const recallInitTime = Date.now() - recallStartTime;
  console.log("✅ Recall service initialized");
  telemetryLog("INFO", "Recall service initialized", {
    initTimeMs: recallInitTime,
    apiHost: process.env.RECALL_API_HOST || "not-set",
  });
} catch (error) {
  telemetryLog("ERROR", "Recall service initialization failed", {
    error: error.message,
    stack: error.stack,
  });
  throw error;
}


console.log("📥 Registering job processors...");
const processors = [
  { name: "calendarwebhooks.save", concurrency: 2, handler: calendarWebhooksSave },
  { name: "calendarevents.update_autorecord", concurrency: 2, handler: calendarEventsUpdateAutorecord },
  { name: "calendarevent.update_bot_schedule", concurrency: 2, handler: calendarEventUpdateBotSchedule },
  { name: "calendarevent.delete_bot", concurrency: 2, handler: calendarEventDeleteBot },
  { name: "recall.calendar.update", concurrency: 2, handler: recallCalendarUpdate },
  { name: "recall.calendar.sync_events", concurrency: 2, handler: recallCalendarSyncEvents },
  { name: "meeting.enrich", concurrency: 2, handler: meetingEnrich },
  { name: "meeting.embed_chunks", concurrency: 2, handler: meetingEmbedChunks },
  { name: "publishing.dispatch", concurrency: 2, handler: publishingDispatch },
  { name: "periodic.calendar.sync", concurrency: 1, handler: periodicCalendarSync },
  { name: "check.calendar.connections", concurrency: 1, handler: checkCalendarConnections },
  { name: "teams.recording.ingest", concurrency: 2, handler: teamsRecordingIngest },
  { name: "meeting.ingest_external", concurrency: 2, handler: meetingIngestExternal },
  { name: "recording.archive", concurrency: 1, handler: recordingArchive },
  { name: "meeting.super_agent.start", concurrency: 2, handler: meetingSuperAgentStart },
  { name: "meeting.super_agent.complete", concurrency: 2, handler: meetingSuperAgentComplete },
  { name: "periodic.enrichment.recovery", concurrency: 1, handler: periodicEnrichmentRecovery },
];

processors.forEach(({ name, concurrency, handler }) => {
  backgroundQueue.process(name, concurrency, handler);
  telemetryLog("INFO", "Job processor registered", {
    processorName: name,
    concurrency,
  });
});

console.log("✅ All job processors registered");
telemetryLog("INFO", "All job processors registered", {
  totalProcessors: processors.length,
});

// Function to schedule periodic sync (extracted so it can be called from multiple places)
async function schedulePeriodicSync() {
  try {
    // Check if Redis is connected by trying to ping
    const redisClient = backgroundQueue.client;
    if (!redisClient) {
      console.warn("⚠️  Redis client not available, retrying in 5 seconds...");
      setTimeout(schedulePeriodicSync, 5000);
      return;
    }

    // Try to ping Redis to verify connection
    try {
      await new Promise((resolve, reject) => {
        redisClient.ping((err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        });
      });
      console.log("✅ Redis connection verified via ping");
    } catch (pingError) {
      console.warn(`⚠️  Redis ping failed: ${pingError.message}, retrying in 5 seconds...`);
      setTimeout(schedulePeriodicSync, 5000);
      return;
    }

    // Remove any existing periodic sync jobs to avoid duplicates
    const existingJobs = await backgroundQueue.getRepeatableJobs();
    for (const job of existingJobs) {
      if (job.name === "periodic.calendar.sync") {
        await backgroundQueue.removeRepeatableByKey(job.key);
        console.log(`🗑️  Removed existing periodic sync job: ${job.key}`);
      }
    }

    // Add new periodic sync job (every 2 minutes for faster event detection)
    // Note: Recall.ai webhooks can be unreliable, so periodic sync is essential
    await backgroundQueue.add(
      "periodic.calendar.sync",
      {},
      {
        repeat: {
          every: 2 * 60 * 1000, // 2 minutes in milliseconds
        },
        jobId: "periodic-calendar-sync", // Unique ID to prevent duplicates
      }
    );

    console.log("⏰ Scheduled periodic calendar sync (every 2 minutes)");
    telemetryLog("INFO", "Periodic sync scheduled", {
      intervalMinutes: 2,
    });

    // Run initial sync immediately (don't wait 2 minutes)
    await backgroundQueue.add("periodic.calendar.sync", {}, { jobId: "periodic-calendar-sync-initial" });
    console.log("🔄 Triggered initial calendar sync");

    // Schedule periodic connection check (every 15 minutes)
    // Remove any existing connection check jobs to avoid duplicates
    for (const job of existingJobs) {
      if (job.name === "check.calendar.connections") {
        await backgroundQueue.removeRepeatableByKey(job.key);
        console.log(`🗑️  Removed existing connection check job: ${job.key}`);
      }
    }

    await backgroundQueue.add(
      "check.calendar.connections",
      {},
      {
        repeat: {
          every: 15 * 60 * 1000, // 15 minutes in milliseconds
        },
        jobId: "check-calendar-connections", // Unique ID to prevent duplicates
      }
    );

    console.log("⏰ Scheduled periodic connection check (every 15 minutes)");
    telemetryLog("INFO", "Connection check scheduled", {
      intervalMinutes: 15,
    });

    // Run initial connection check immediately (don't wait 15 minutes)
    await backgroundQueue.add("check.calendar.connections", {}, { jobId: "check-calendar-connections-initial" });
    console.log("🔄 Triggered initial connection check");

    // Schedule periodic enrichment recovery (every 10 minutes)
    // Recovers meetings stuck at status:done with no MeetingSummary due to missed webhooks
    for (const job of existingJobs) {
      if (job.name === "periodic.enrichment.recovery") {
        await backgroundQueue.removeRepeatableByKey(job.key);
        console.log(`🗑️  Removed existing enrichment recovery job: ${job.key}`);
      }
    }

    await backgroundQueue.add(
      "periodic.enrichment.recovery",
      {},
      {
        repeat: {
          every: 10 * 60 * 1000, // 10 minutes in milliseconds
        },
        jobId: "periodic-enrichment-recovery",
      }
    );

    console.log("⏰ Scheduled periodic enrichment recovery (every 10 minutes)");
    telemetryLog("INFO", "Enrichment recovery scheduled", {
      intervalMinutes: 10,
    });
  } catch (error) {
    console.error("❌ Failed to schedule periodic sync:", error);
    telemetryLog("ERROR", "Failed to schedule periodic sync", {
      error: error.message,
      stack: error.stack,
    });
    // Retry after 10 seconds if scheduling failed
    setTimeout(schedulePeriodicSync, 10000);
  }
}

backgroundQueue.on("ready", async () => {
  console.log("✅ Redis connection established - Queue is ready");
  console.log("🎯 Worker is now listening for jobs...");
  
  // #region agent log
  fetch('http://127.0.0.1:7250/ingest/bf0206c3-6e13-4499-92a3-7fb2b7527fcf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'worker/index.js:redis_ready',message:'Redis queue ready - periodic sync can be scheduled',data:{redisUrl:process.env.REDIS_URL?'configured':'not-set',queueName:backgroundQueue.name},timestamp:Date.now(),sessionId:'debug-session',runId:'worker-start',hypothesisId:'C'})}).catch(()=>{});
  // #endregion
  
  telemetryLog("INFO", "Redis queue ready", {
    queueName: backgroundQueue.name,
    redisUrl: process.env.REDIS_URL ? "configured" : "not-set",
  });

  // Verify connection to shared resources
  try {
    const { Calendar } = await import("../models/calendar.js");
    const calendarCount = await Calendar.count();
    
    // #region agent log
    fetch('http://127.0.0.1:7250/ingest/bf0206c3-6e13-4499-92a3-7fb2b7527fcf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'worker/index.js:connection_verified',message:'Worker connection verified - sharing database with main service',data:{calendarCount:calendarCount,redisConnected:true,databaseConnected:true},timestamp:Date.now(),sessionId:'debug-session',runId:'worker-start',hypothesisId:'D'})}).catch(()=>{});
    // #endregion
    
    console.log(`✅ Connection verified: Found ${calendarCount} calendars in shared database`);
  } catch (error) {
    // #region agent log
    fetch('http://127.0.0.1:7250/ingest/bf0206c3-6e13-4499-92a3-7fb2b7527fcf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'worker/index.js:connection_verify_failed',message:'Failed to verify worker connection',data:{error:error.message},timestamp:Date.now(),sessionId:'debug-session',runId:'worker-start',hypothesisId:'D'})}).catch(()=>{});
    // #endregion
    
    console.warn(`⚠️  Could not verify database connection: ${error.message}`);
  }

  // Schedule periodic sync when ready event fires
  await schedulePeriodicSync();
});

// FALLBACK: Schedule periodic sync even if "ready" event doesn't fire
// This ensures sync is scheduled even if the ready event is delayed or doesn't fire
// Wait 3 seconds after startup to allow Redis connection to establish
setTimeout(async () => {
  try {
    // Check if periodic sync is already scheduled
    const existingJobs = await backgroundQueue.getRepeatableJobs();
    const hasPeriodicSync = existingJobs.some(job => job.name === "periodic.calendar.sync");
    
    if (!hasPeriodicSync) {
      console.log("⚠️  Periodic sync not scheduled via 'ready' event, scheduling via fallback...");
      await schedulePeriodicSync();
    } else {
      console.log("✅ Periodic sync already scheduled (via ready event)");
    }
  } catch (error) {
    console.error("❌ Fallback periodic sync scheduling failed:", error.message);
    // Retry after 10 seconds
    setTimeout(async () => {
      try {
        await schedulePeriodicSync();
      } catch (retryError) {
        console.error("❌ Fallback retry also failed:", retryError.message);
      }
    }, 10000);
  }
}, 3000);

// Rate-limit queue error logging to avoid flooding (e.g. WRONGPASS retries) and Railway rate limits
let lastQueueErrorLog = 0;
const QUEUE_ERROR_LOG_INTERVAL_MS = 60_000;

backgroundQueue.on("error", (error) => {
  const now = Date.now();
  if (now - lastQueueErrorLog < QUEUE_ERROR_LOG_INTERVAL_MS) return;
  lastQueueErrorLog = now;

  console.error("❌ Queue error:", error.message);
  telemetryLog("ERROR", "Queue error", {
    error: error.message,
    code: error.code,
  });
});

backgroundQueue.on("active", async (job) => {
  const jobStartTime = Date.now();
  console.log(`▶️  [${job.queue.name}] Started job ${job.id} (${job.name})`);
  telemetryLog("INFO", "Job started", {
    jobId: job.id,
    jobName: job.name,
    queueName: job.queue.name,
    data: job.data,
    timestamp: jobStartTime,
  });
});

backgroundQueue.on("completed", async (job, result) => {
  const jobDuration = Date.now() - (job.processedOn || Date.now());
  console.log(`✅ [${job.queue.name}] Completed job ${job.id} (${job.name})`);
  telemetryLog("INFO", "Job completed", {
    jobId: job.id,
    jobName: job.name,
    queueName: job.queue.name,
    durationMs: jobDuration,
    attemptsMade: job.attemptsMade,
    result: result ? (typeof result === "object" ? JSON.stringify(result).substring(0, 200) : result) : null,
  });
});

backgroundQueue.on("failed", async (job, err) => {
  const jobDuration = job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null;
  console.error(`❌ [${job.queue.name}] Failed job ${job.id} (${job.name}):`, err.message);
  telemetryLog("ERROR", "Job failed", {
    jobId: job.id,
    jobName: job.name,
    queueName: job.queue.name,
    error: err.message,
    errorStack: err.stack,
    attemptsMade: job.attemptsMade,
    durationMs: jobDuration,
    data: job.data,
  });
});

backgroundQueue.on("stalled", async (job) => {
  console.warn(`⚠️  [${job.queue.name}] Stalled job ${job.id} (${job.name})`);
  telemetryLog("WARN", "Job stalled", {
    jobId: job.id,
    jobName: job.name,
    queueName: job.queue.name,
    attemptsMade: job.attemptsMade,
  });
});

process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down worker gracefully...");
  telemetryLog("INFO", "Worker shutdown initiated", { signal: "SIGINT" });
  try {
    await backgroundQueue.close();
    console.log("✅ Worker shut down complete");
    telemetryLog("INFO", "Worker shutdown complete", { signal: "SIGINT" });
  } catch (error) {
    telemetryLog("ERROR", "Error during shutdown", {
      error: error.message,
      stack: error.stack,
    });
  } finally {
    debugLogStream.end();
    process.exit(0);
  }
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 Received SIGTERM, shutting down worker...");
  telemetryLog("INFO", "Worker shutdown initiated", { signal: "SIGTERM" });
  try {
    await backgroundQueue.close();
    console.log("✅ Worker shut down complete");
    telemetryLog("INFO", "Worker shutdown complete", { signal: "SIGTERM" });
  } catch (error) {
    telemetryLog("ERROR", "Error during shutdown", {
      error: error.message,
      stack: error.stack,
    });
  } finally {
    debugLogStream.end();
    process.exit(0);
  }
});

// Log uncaught exceptions
process.on("uncaughtException", (error) => {
  telemetryLog("ERROR", "Uncaught exception", {
    error: error.message,
    stack: error.stack,
  });
  debugLogStream.end();
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  telemetryLog("ERROR", "Unhandled promise rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

console.log("🎉 Worker startup complete - Ready to process jobs!");
telemetryLog("INFO", "Worker startup complete", {
  uptime: process.uptime(),
  memoryUsage: process.memoryUsage(),
});
