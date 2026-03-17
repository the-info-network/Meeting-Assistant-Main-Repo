# Why the AI Agent Joins Multiple Times (Duplicate Bots)

This doc explains likely causes and how to confirm them using **Railway logs**.

## Likely causes (from code analysis)

### 1. **"Send bot again" clicked multiple times** (most likely)

- **Where:** `recall/routes/calendar-event/send-bot-again.js` calls `queueBotScheduleJob(..., { forceReschedule: true, **isRetry: true** })`.
- **Effect:** Each click uses a **new** deduplication key: `recall-event-{eventId}-retry-{Date.now()}`. Recall treats each request as a new bot, so **every click creates another bot**.
- **Result:** 3 clicks → 3 "Gene's Assistant" participants.

**In Railway logs, look for:**
- `INFO: Send bot again requested for event(ID: ...)` (each click)
- `[BOT-SCHEDULE] Calling Recall API to schedule bot: ... deduplicationKey=recall-event-...-retry-...`
- Multiple `Bot scheduled successfully` for the same meeting in a short time

### 2. **Multiple calendar events for the same meeting**

- If the same meeting appears on **several calendars** (e.g. different users or calendars), each event has its own `recallId`. The worker can schedule one bot **per event**.
- Shared-bot logic is supposed to let only the **organizer** schedule for the same meeting URL (same company). If organizer detection fails or company domain isn’t shared, multiple bots can be scheduled.

**In Railway logs, look for:**
- `[SHARED-BOT] Using shared deduplication key` vs no shared-bot message for the same meeting
- `[SHARED-BOT] Skipping - not meeting organizer` (expected when only one bot is wanted)
- Multiple `[BOT-SCHEDULE] Processing bot scheduling job: eventId=` with **different** `eventId` values for the same meeting time/URL

### 3. **Periodic sync + webhooks re-queuing the same event**

- **calendar.event.updated** (or similar) webhooks trigger `recall.calendar.sync_events`. The sync processor then queues **one** `calendarevent.update_bot_schedule` per event that should be recorded.
- Queue deduplication uses `jobId = bot-schedule-{recallEventId}`, so **only one job per event** should run. When the job finishes, it’s removed (`removeOnComplete: true`). If another webhook arrives **after** that, a **new** job is added and runs, and can call the Recall API again.
- If `event.recallData.bots` isn’t updated yet (e.g. slow webhook from Recall), the “already has active bot” check may not see the bot and a second bot is scheduled.

**In Railway logs, look for:**
- Multiple `[BOT-SCHEDULE] 🚀 Processing bot scheduling job: eventId=<same id>` for the same `eventId` (same line, different timestamps)
- `[BOT-SCHEDULE] Skipping - event X already has active bot` (shows the guard is working when present)
- `[BOT-SCHEDULE] ⚠️ WARNING: Multiple bots detected for event`

### 4. **Retry job creates a new bot by design**

- With `isRetry: true`, the code **intentionally** uses a unique dedup key so Recall creates a **new** bot (e.g. meeting started late). So any path that sets `isRetry: true` (including “Send bot again”) can create an extra bot per run.

### 5. **Transcript webhooks and duplicate meeting artifacts**

- Recall **transcript** webhooks (`transcript.partial_data`, `transcript.data`) send the bot ID as **`data.bot.id`** (nested object), not `data.bot_id`. If the webhook handler only read `bot_id`/`botId`, `recallBotId` (and often `recallEventId`) stayed **null**.
- With null IDs, every webhook was treated as a new meeting, so the handler created a **new artifact per chunk** instead of updating one per bot. That caused many duplicate artifacts and **"Could not generate unique readableId after 20 retries"** (readableId collisions). The fix: extract **`data.bot?.id`** and **`data.recall_event_id`** in `extractRecallIdentifiers` (see `recall/routes/webhooks/recall-notes.js`) so transcript webhooks resolve to a single artifact per bot.

---

## How to get Railway logs

### Option 1: Script (no need to link a service)

From the repo root, run the helper script; it uses your Railway config and API to list services and stream logs:

```bash
cd /path/to/Recall.ai

# Worker logs (bot scheduling – use this for duplicate-bot investigation)
node recall/scripts/railway-logs.js --service "Meeting Worker 7/24" --lines 500

# Web app logs
node recall/scripts/railway-logs.js --service "Meeting Assistant V1" --lines 300
```

If you omit `--service`, it uses the first service in the project (often Redis); specify the worker or web service by name as above.

### Option 2: Railway CLI (after linking a service)

1. **Link the worker service** (so logs are for the app that schedules bots):
   ```bash
   cd /path/to/Recall.ai
   railway link   # if needed
   railway service   # pick "Meeting Worker 7/24" (or your worker service name)
   ```

2. **Fetch recent logs (no streaming):**
   ```bash
   railway logs -n 500
   ```
   Or for a specific service by name without linking:
   ```bash
   railway logs -n 500 --service "Meeting Worker 7/24"
   ```

3. **Search for bot-scheduling and duplicates:**
   - `BOT-SCHEDULE` – every bot schedule attempt
   - `Send bot again` – manual “send bot again” clicks
   - `deduplicationKey` – same vs different keys for the same meeting
   - `Multiple bots detected` – duplicate bots already seen by the app
   - `SHARED-BOT` – shared-bot / organizer logic
   - `409` / `conflict` – Recall deduplication; same key already in progress (expected when shared-bot logic runs)

4. **Filter by errors (optional):**
   ```bash
   railway logs -n 200 --filter "@level:error"
   ```

### Interpreting logs for duplicate bots

- **Same meeting, multiple event IDs:** Multiple `[BOT-SCHEDULE] Processing bot scheduling job: eventId=<id>` lines with *different* `eventId` values but the same meeting (e.g. same `deduplicationKey` or same meeting name) mean multiple calendar events point at one meeting. Shared dedup key should still result in one bot; look for `SHARED-BOT` and `deduplicationKey=shared-bot-...`.
- **Multiple bots created:** Look for several `Recall.addBotToCalendarEvent.request` or `Bot scheduled successfully` entries for the same meeting in a short window, especially with `deduplicationKey=...-retry-...` (indicates “Send bot again” or retry path).
- **Recurring meetings:** If the same meeting name appears with *different* meeting URLs (different `shared-bot-...-thread-...` segments), each URL gets its own bot; that can explain multiple “Gene’s Assistant” for recurring “Pet Store Direct Stand Up” if each occurrence has a different join link.

---

## Recommended next steps

1. **Confirm in logs** using the search terms above; note whether you see multiple “Send bot again” or multiple schedule jobs for the same event/meeting.
2. **If “Send bot again” is the cause:** Reduce duplicate joins by either:
   - **Option A:** Use a **stable** retry dedup key (e.g. `recall-event-{eventId}-retry` without `Date.now()`) so repeated “Send bot again” clicks reuse the same bot request, or
   - **Option B:** Throttle the UI (e.g. disable “Send bot again” for 1–2 minutes after one click).
3. **If multiple events per meeting:** Verify shared-bot and organizer logic (same company, same meeting URL, only organizer schedules) and that `event.recallData.bots` is up to date before scheduling.

If you paste a redacted snippet of Railway logs around a meeting where you saw 3 bots, the exact cause can be pinned down.
