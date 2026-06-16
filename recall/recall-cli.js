#!/usr/bin/env node
/**
 * Recall.ai CLI diagnostic tool
 *
 * Usage (with Railway env vars):
 *   railway run node recall/recall-cli.js bots
 *   railway run node recall/recall-cli.js events
 *   railway run node recall/recall-cli.js event <recallEventId>
 *   railway run node recall/recall-cli.js add-bot <recallEventId>
 *
 * Usage (with local .env):
 *   node recall/recall-cli.js bots
 */

import dotenv from "dotenv";
dotenv.config();

const API_KEY = process.env.RECALL_API_KEY;
const API_HOST = (process.env.RECALL_API_HOST || "https://us-west-2.recall.ai").replace(/\/$/, "");

if (!API_KEY) {
  console.error("❌ RECALL_API_KEY not set");
  process.exit(1);
}

async function api(method, path, body) {
  const url = `${API_HOST}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Token ${API_KEY}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return JSON.parse(text);
}

// ---- commands ----

async function listBots() {
  console.log("🤖 Recent bots in Recall.ai:\n");
  const data = await api("GET", "/api/v2/bots/?page_size=20");
  const bots = data.results || data;
  if (!bots.length) { console.log("  (none)"); return; }
  for (const bot of bots) {
    const status = bot.status?.code ?? bot.status ?? "unknown";
    const meetingUrl = bot.meeting_url ?? "(no url)";
    const joinAt = bot.join_at ?? bot.scheduled_start ?? "(no join_at)";
    console.log(`  ${bot.id}`);
    console.log(`    Status : ${status}`);
    console.log(`    URL    : ${meetingUrl}`);
    console.log(`    Join at: ${joinAt}`);
    console.log(`    Created: ${bot.created_at ?? "(unknown)"}`);
    console.log();
  }
}

async function listEvents() {
  console.log("📅 Upcoming calendar events in Recall.ai:\n");
  // Fetch all calendars first
  const calData = await api("GET", "/api/v2/calendars/?page_size=50");
  const calendars = calData.results || calData;
  if (!calendars.length) { console.log("  No calendars found"); return; }

  for (const cal of calendars) {
    console.log(`Calendar: ${cal.email ?? cal.id}`);
    try {
      const evData = await api("GET", `/api/v2/calendar-events/?calendar_id=${cal.id}&page_size=20`);
      const events = evData.results || evData;
      const now = new Date();
      const upcoming = events.filter(e => new Date(e.start_time) > now);
      if (!upcoming.length) { console.log("  (no upcoming events)\n"); continue; }
      for (const ev of upcoming) {
        const bots = ev.bots ?? [];
        console.log(`  ${ev.id}`);
        console.log(`    Title   : ${ev.raw?.subject ?? ev.raw?.summary ?? "(no title)"}`);
        console.log(`    Start   : ${ev.start_time}`);
        console.log(`    URL     : ${ev.meeting_url ?? "❌ none"}`);
        console.log(`    Bots    : ${bots.length ? bots.map(b => `${b.bot_id ?? b.id} (${b.status?.code ?? b.status ?? "?"})` ).join(", ") : "❌ none"}`);
        console.log();
      }
    } catch (err) {
      console.log(`  Error fetching events: ${err.message}\n`);
    }
  }
}

async function showEvent(recallEventId) {
  console.log(`📅 Event ${recallEventId}:\n`);
  const ev = await api("GET", `/api/v2/calendar-events/${recallEventId}/`);
  console.log(JSON.stringify(ev, null, 2));
}

async function addBot(recallEventId) {
  console.log(`🤖 Adding bot to event ${recallEventId}...\n`);
  const joinAt = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes from now
  const body = {
    bot_config: {
      join_at: joinAt.toISOString(),
      recording_config: {
        video_mixed_mp4: {},
        audio_mixed_mp3: {},
        transcript: {
          provider: { recallai_streaming: { mode: "prioritize_accuracy" } },
        },
      },
    },
    deduplication_key: `cli-${Date.now()}`,
  };
  console.log("Sending:", JSON.stringify(body, null, 2));
  const result = await api("POST", `/api/v2/calendar-events/${recallEventId}/bot/`, body);
  console.log("\n✅ Response:");
  console.log(JSON.stringify(result, null, 2));
}

// ---- main ----

const [,, command, arg] = process.argv;

try {
  if (command === "bots") await listBots();
  else if (command === "events") await listEvents();
  else if (command === "event" && arg) await showEvent(arg);
  else if (command === "add-bot" && arg) await addBot(arg);
  else {
    console.log("Usage:");
    console.log("  railway run node recall/recall-cli.js bots");
    console.log("  railway run node recall/recall-cli.js events");
    console.log("  railway run node recall/recall-cli.js event <recallEventId>");
    console.log("  railway run node recall/recall-cli.js add-bot <recallEventId>");
  }
} catch (err) {
  console.error("❌", err.message);
  process.exit(1);
}
