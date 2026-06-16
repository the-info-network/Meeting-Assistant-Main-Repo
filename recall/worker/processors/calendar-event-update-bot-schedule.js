import Recall from "../../services/recall/index.js";
import db from "../../db.js";
import { buildBotConfig } from "../../logic/bot-config.js";
import { telemetryEvent } from "../../utils/telemetry.js";
import { checkForSharedBot, getSharedDeduplicationKey, findExistingBotForMeeting, getMeetingOrganizerEmail, extractCompanyDomain } from "../../utils/shared-bot-scheduling.js";

// add or remove bot for a calendar event based on its record status
export default async (job) => {
  const { recallEventId, isRetry = false } = job.data;
  const jobId = job.id || job.opts?.jobId || 'unknown';
  console.log(`[BOT-SCHEDULE] 🚀 Processing bot scheduling job: eventId=${recallEventId} jobId=${jobId}`);
  
  await telemetryEvent(
    "BotScheduling.job_started",
    { recallEventId, jobId },
    { location: "worker/processors/calendar-event-update-bot-schedule.js:job_start" }
  );
  
  const event = await db.CalendarEvent.findOne({
    where: { recallId: recallEventId },
  });
  
  await telemetryEvent(
    "BotScheduling.event_loaded",
    {
      recallEventId,
      hasEvent: !!event,
      eventId: event?.id,
      shouldRecordAutomatic: event?.shouldRecordAutomatic,
      shouldRecordManual: event?.shouldRecordManual,
      hasMeetingUrl: !!event?.meetingUrl,
    },
    { location: "worker/processors/calendar-event-update-bot-schedule.js:event_loaded" }
  );

  // If event not found, log and return (event may not be synced yet)
  if (!event) {
    console.warn(`[BOT_CONFIG] Event not found for recallEventId ${recallEventId} - event may not be synced yet`);
    return;
  }

  let updatedEventFromRecall = null;
  if (
    (event.shouldRecordAutomatic || event.shouldRecordManual) &&
    event.meetingUrl
  ) {
    console.log(`INFO: Schedule bot for event ${event.id}`);
    
    // Get calendar to check bot settings (with user for shared bot detection)
    const calendar = await db.Calendar.findByPk(event.calendarId, {
      include: [{ model: db.User }],
    });

    // Determine public URL for webhooks (try multiple sources)
    let publicUrl = process.env.PUBLIC_URL;
    if (!publicUrl && process.env.RAILWAY_PUBLIC_DOMAIN) {
      publicUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
    }
    if (!publicUrl && process.env.RAILWAY_STATIC_URL) {
      publicUrl = process.env.RAILWAY_STATIC_URL;
    }
    
    // Determine effective transcription mode (event override takes precedence)
    const effectiveTranscriptionMode = event.transcriptionMode || calendar?.transcriptionMode || "realtime";
    console.log(`[BOT_CONFIG] Calendar settings: enableTranscription=${calendar?.enableTranscription}, transcriptionMode=${calendar?.transcriptionMode}`);
    console.log(`[BOT_CONFIG] Event override: transcriptionMode=${event.transcriptionMode}, effective=${effectiveTranscriptionMode}`);
    console.log(`[BOT_CONFIG] Public URL for webhooks: ${publicUrl || 'NOT SET - realtime_endpoints will be empty!'}`);

    // #region agent log
    fetch('http://127.0.0.1:7250/ingest/bf0206c3-6e13-4499-92a3-7fb2b7527fcf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'worker/processors/calendar-event-update-bot-schedule.js:calendar_settings',message:'Calendar settings used for bot config',data:{eventId:event.id,recallEventId:event.recallId,calendarId:calendar?.id,calendarSettings:{botName:calendar?.botName,recordVideo:calendar?.recordVideo,recordAudio:calendar?.recordAudio,enableTranscription:calendar?.enableTranscription,transcriptionMode:calendar?.transcriptionMode,enableSummary:calendar?.enableSummary,joinBeforeStartMinutes:calendar?.joinBeforeStartMinutes}},timestamp:Date.now(),sessionId:'debug-session',runId:'settings-change',hypothesisId:'C'})}).catch(()=>{});
    // #endregion

    // Build bot config from calendar settings + event overrides (shared logic)
    const botConfig = buildBotConfig({
      calendar,
      event,  // Pass event for per-meeting transcription override
      publicUrl,
    });
    
    // #region agent log
    const bd = botConfig?.automatic_leave?.bot_detection;
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'worker/processors/calendar-event-update-bot-schedule.js:bot_config_built',message:'Bot config built (bot_detection under automatic_leave)',data:{eventId:event.id,recallEventId:event.recallId,hasBotDetection:!!bd,activateAfterNames:bd?.using_participant_names?.activate_after,activateAfterEvents:bd?.using_participant_events?.activate_after,timeoutNames:bd?.using_participant_names?.timeout},timestamp:Date.now(),hypothesisId:'H2'})}).catch(()=>{});
    // #endregion
    
    // Calculate join_at time - this is when the bot actually joins the meeting
    // Note: The 10-minute "scheduled bot" requirement is about when you CALL the API,
    // not when the bot joins. join_at can be set to any time before the meeting starts.
    // Recall API expects join_at as ISO8601 datetime string
    const now = new Date();
    const joinBeforeStartMinutes = calendar?.joinBeforeStartMinutes ?? 1;
    const joinAtTime = new Date(event.startTime);
    joinAtTime.setMinutes(joinAtTime.getMinutes() - joinBeforeStartMinutes);
    
    // Add join_at to bot config
    if (event.startTime && event.startTime > now) {
      // Future meeting: join shortly before start
      botConfig.join_at = joinAtTime.toISOString();
    } else if (event.startTime && event.startTime <= now) {
      // Meeting in progress: join immediately (ad-hoc bot). Omit join_at or set to now
      // so Recall creates an ad-hoc bot that joins right away.
      botConfig.join_at = now.toISOString();
    }
    
    // #region agent log
    fetch('http://127.0.0.1:7250/ingest/bf0206c3-6e13-4499-92a3-7fb2b7527fcf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'worker/processors/calendar-event-update-bot-schedule.js:join_at_calculated',message:'Join_at time calculated',data:{eventId:event.id,startTime:event.startTime.toISOString(),joinAtTime:joinAtTime.toISOString(),joinBeforeStartMinutes:joinBeforeStartMinutes,hasJoinAt:!!botConfig.join_at,joinAtValue:botConfig.join_at},timestamp:Date.now(),sessionId:'debug-session',runId:'bot-schedule',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    
    // Check for shared bot from same company
    const userEmail = calendar?.User?.email;
    
    // For retry (e.g. meeting started late), use unique key so Recall creates a new bot
    let deduplicationKey = isRetry
      ? `recall-event-${event.recallId}-retry-${Date.now()}`
      : `recall-event-${event.recallId}`;
    let sharedBotInfo = null;
    
    if (event.meetingUrl && userEmail) {
      // Check if another user from the same company already has a bot scheduled
      sharedBotInfo = await checkForSharedBot(event.meetingUrl, calendar.userId, userEmail);
      const organizerEmail = getMeetingOrganizerEmail(event);
      const isOrganizer = organizerEmail && userEmail &&
        organizerEmail.toLowerCase().trim() === userEmail.toLowerCase().trim();
      const isSameCompany = !!extractCompanyDomain(userEmail);

      await telemetryEvent(
        "BotScheduling.shared_bot_decision",
        {
          recallEventId: event.recallId,
          eventId: event.id,
          userEmail,
          organizerEmail: organizerEmail || null,
          isOrganizer,
          isSameCompany,
          hasSharedBot: sharedBotInfo?.hasSharedBot ?? false,
          sharedEventId: sharedBotInfo?.sharedEventId ?? null,
          sharedUserEmail: sharedBotInfo?.sharedUserEmail ?? null,
        },
        { location: "worker/processors/calendar-event-update-bot-schedule.js:shared_bot_decision" }
      );

      // #region agent log
      fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'worker/processors/calendar-event-update-bot-schedule.js:shared_bot_check',message:'Shared bot check result',data:{recallEventId:event.recallId,eventId:event.id,hasSharedBot:sharedBotInfo?.hasSharedBot,sharedBotId:sharedBotInfo?.sharedBotId,sharedEventId:sharedBotInfo?.sharedEventId,organizerEmail:organizerEmail||null,isOrganizer,sharedUserEmail:sharedBotInfo?.sharedUserEmail},timestamp:Date.now(),hypothesisId:'H1'})}).catch(()=>{});
      // #endregion

      if (!isRetry && sharedBotInfo.hasSharedBot && sharedBotInfo.sharedBotId) {
        // A bot is already scheduled for this meeting (same company). Attach it to this event
        // so this user sees "Bot scheduled" and gets the recording, then skip creating another.
        // Skip this when isRetry - user explicitly wants a new bot (e.g. meeting started late).
        const existing = await findExistingBotForMeeting(
          event.meetingUrl,
          userEmail,
          sharedBotInfo.sharedEventId
        );
        if (existing?.bots?.length > 0) {
          const merged = { ...(event.recallData || {}), bots: existing.bots };
          event.recallData = merged;
          await event.save();
          console.log(
            `[SHARED-BOT] Attached existing bot to event ${event.id}: botIds=[${existing.bots.map(b => b.id).join(", ")}] sharedUser=${sharedBotInfo.sharedUserEmail} isOrganizer=${isOrganizer}`
          );
        }
        console.log(
          `[SHARED-BOT] Skipping - bot already scheduled: eventId=${event.id} sharedEventId=${sharedBotInfo.sharedEventId} sharedUser=${sharedBotInfo.sharedUserEmail} isOrganizer=${isOrganizer}`
        );
        return;
      }

      // Same company but no shared bot yet: only the meeting organizer should schedule,
      // so the bot that joins is the owner's (name/settings). Participants will attach when organizer's bot exists.
      // Only skip if we can CONFIRM the organizer is someone else. If organizerEmail is null/unknown,
      // fall through and schedule (safe default: better to have a bot than miss a meeting).
      if (isSameCompany && organizerEmail && !isOrganizer) {
        console.log(
          `[SHARED-BOT] Skipping - not meeting organizer (only organizer schedules for company): eventId=${event.id} user=${userEmail} organizer=${organizerEmail}`
        );
        await telemetryEvent(
          "BotScheduling.skipped_not_organizer",
          { recallEventId: event.recallId, eventId: event.id, userEmail, organizerEmail },
          { location: "worker/processors/calendar-event-update-bot-schedule.js:skip_not_organizer" }
        );
        return;
      }

      // Use shared deduplication key for company coordination (skip for retry - we want a new bot)
      const sharedKey = !isRetry && getSharedDeduplicationKey(event.meetingUrl, userEmail);
      if (sharedKey) {
        deduplicationKey = sharedKey;
        console.log(`[SHARED-BOT] Using shared deduplication key: ${deduplicationKey}`);
      }
    }
    
    // #region agent log
    fetch('http://127.0.0.1:7248/ingest/9df62f0f-78c1-44fb-821f-c3c7b9f764cc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'worker/processors/calendar-event-update-bot-schedule.js:dedup_key_resolved',message:'Dedup key before API call',data:{recallEventId:event.recallId,eventId:event.id,deduplicationKey,isSharedKey:deduplicationKey!==`recall-event-${event.recallId}`},timestamp:Date.now(),hypothesisId:'H2'})}).catch(()=>{});
    // #endregion
    
    // Log only a compact summary (Railway log rate limiting can drop important messages)
    console.log(
      `[BOT_CONFIG] Scheduling summary: eventId=${event.id} recallEventId=${event.recallId} start=${event.startTime.toISOString()} join_at=${botConfig.join_at || "not_set"} hasMeetingUrl=${!!event.meetingUrl} deduplicationKey=${deduplicationKey}${sharedBotInfo?.hasSharedBot ? ' [SHARED]' : ''}`
    );
    
    // Validate event is not fully in the past before scheduling
    // Allow "in progress" meetings (started but not ended) - user can send bot mid-meeting
    const eventEndTime = event.recallData?.end_time ? new Date(event.recallData.end_time) : null;
    const hasValidEndTime = eventEndTime && !isNaN(eventEndTime.getTime());
    const isMeetingEnded = hasValidEndTime && eventEndTime < now;
    const startedLongAgo = now - event.startTime > 24 * 60 * 60 * 1000; // > 24h
    const isMeetingInProgress = event.startTime <= now && !isMeetingEnded && !startedLongAgo;
    if (event.startTime > now) {
      // Future meeting - will use join_at before start
    } else if (isMeetingInProgress) {
      // In progress - will use join_at = now for immediate join
      console.log(`[BOT_CONFIG] Scheduling bot for in-progress meeting: eventId=${event.id} recallEventId=${event.recallId} (bot will join immediately)`);
    } else {
      // Meeting has ended or started too long ago - skip
      // #region agent log
      fetch('http://127.0.0.1:7250/ingest/bf0206c3-6e13-4499-92a3-7fb2b7527fcf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'worker/processors/calendar-event-update-bot-schedule.js:skipped_ended_event',message:'Skipping ended event',data:{eventId:event.id,recallEventId:event.recallId,startTime:event.startTime.toISOString(),endTime:eventEndTime?.toISOString(),now:now.toISOString(),startedLongAgo},timestamp:Date.now(),sessionId:'debug-session',runId:'bot-schedule',hypothesisId:'D'})}).catch(()=>{});
      // #endregion
      console.warn(
        `[BOT_CONFIG] Skipping (meeting ended or too old): eventId=${event.id} recallEventId=${event.recallId} start=${event.startTime.toISOString()} end=${eventEndTime?.toISOString() || 'unknown'}`
      );
      return;
    }
    
    // Skip if event already has an active bot (prevents repeated joins from periodic sync/webhooks).
    // isRetry bypasses this - user explicitly wants a new bot (e.g. meeting started late).
    if (!isRetry) {
      const bots = event.recallData?.bots || [];
      const activeStatuses = ['in_call', 'joined_call', 'in_call_recording', 'in_call_not_recording', 'joining_call', 'in_waiting_room'];
      const hasActiveBot = bots.some(b => {
        const code = (b?.status?.code ?? b?.status ?? '').toString().toLowerCase();
        const lastChange = b?.status_changes?.[b.status_changes?.length - 1];
        const lastCode = (lastChange?.code ?? lastChange ?? '').toString().toLowerCase();
        return activeStatuses.includes(code) || activeStatuses.includes(lastCode);
      });
      if (hasActiveBot) {
        console.log(`[BOT-SCHEDULE] Skipping - event ${event.id} already has active bot (prevents repeated joins)`);
        return;
      }
    }

    // #region agent log
    fetch('http://127.0.0.1:7638/ingest/79656976-3d7d-40e3-8c2f-1fcd56f4a972',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'72392a'},body:JSON.stringify({sessionId:'72392a',location:'worker/processors/calendar-event-update-bot-schedule.js:before_api_call',message:'Before calling Recall API to schedule bot',data:{eventId:event.id,recallEventId:event.recallId,deduplicationKey:deduplicationKey,botConfigKeys:Object.keys(botConfig),hasJoinAt:!!botConfig.join_at},timestamp:Date.now(),runId:'bot-schedule',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    
    // add a bot to record the event. Recall will handle the case where the bot already exists.
    try {
      console.log(`[BOT-SCHEDULE] Calling Recall API to schedule bot: eventId=${event.id} recallEventId=${event.recallId} deduplicationKey=${deduplicationKey}`);
      
      updatedEventFromRecall = await Recall.addBotToCalendarEvent({
        id: event.recallId,
        deduplicationKey,
        botConfig,
      });
      
      // Log bot IDs if returned
      const botIds = updatedEventFromRecall?.bots?.map(b => b.id) || [];
      if (botIds.length > 0) {
        console.log(`[BOT-SCHEDULE] Bot scheduled successfully: eventId=${event.id} botIds=[${botIds.join(', ')}]`);
      } else {
        console.log(`[BOT-SCHEDULE] Bot scheduling completed but no bot IDs returned: eventId=${event.id}`);
      }
      
      // Check for duplicate bots
      if (botIds.length > 1) {
        console.warn(`[BOT-SCHEDULE] ⚠️  WARNING: Multiple bots detected for event ${event.id}: botIds=[${botIds.join(', ')}]`);
      }
      
      // #region agent log
      fetch('http://127.0.0.1:7638/ingest/79656976-3d7d-40e3-8c2f-1fcd56f4a972',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'72392a'},body:JSON.stringify({sessionId:'72392a',location:'worker/processors/calendar-event-update-bot-schedule.js:api_call_success',message:'Recall API call succeeded',data:{eventId:event.id,recallEventId:event.recallId,deduplicationKey,hasResult:!!updatedEventFromRecall,botIds,botCount:botIds.length},timestamp:Date.now(),hypothesisId:'H5'})}).catch(()=>{});
      // #endregion
      
    } catch (error) {
      // #region agent log
      fetch('http://127.0.0.1:7638/ingest/79656976-3d7d-40e3-8c2f-1fcd56f4a972',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'72392a'},body:JSON.stringify({sessionId:'72392a',location:'worker/processors/calendar-event-update-bot-schedule.js:api_call_failed',message:'Recall API call failed',data:{eventId:event.id,recallEventId:event.recallId,deduplicationKey,errorMessage:error.message,errorStatus:error.res?.status,is409:error.message?.includes('409')||error.message?.includes('conflict')},timestamp:Date.now(),hypothesisId:'H4'})}).catch(()=>{});
      // #endregion
      
      // Handle 409 conflict gracefully - another request with same deduplication key succeeded (shared bot).
      // Attach the existing bot to this event's record so our DB and UI show the meeting as having the bot.
      if (error.message?.includes('status 409') || error.message?.includes('conflict')) {
        const usedSharedKey = deduplicationKey !== `recall-event-${event.recallId}`;
        if (usedSharedKey && event.meetingUrl && userEmail) {
          const existing = await findExistingBotForMeeting(
            event.meetingUrl,
            userEmail,
            sharedBotInfo?.sharedEventId
          );
          if (existing?.bots?.length > 0) {
            const merged = { ...(event.recallData || {}), bots: existing.bots };
            event.recallData = merged;
            await event.save();
            console.log(`[SHARED-BOT] Attached existing bot to event ${event.id} (409): botIds=[${existing.bots.map(b => b.id).join(', ')}]`);
          }
        }
        console.log(`[BOT_CONFIG] Bot scheduling deduplicated (409 conflict) for event ${event.id} - another request is in progress`);
        return; // Don't throw - this is expected behavior for shared bots
      }
      
      console.error(`[BOT_CONFIG] Failed to schedule bot for event ${event.id}:`, error.message);
      // Log the full error for debugging
      if (error.res) {
        const errorBody = await error.res.text().catch(() => 'Unable to read error body');
        console.error(`[BOT_CONFIG] Recall API error response:`, errorBody);
      }
      throw error; // Re-throw to mark job as failed
    }
    
    console.log(`[BOT_CONFIG] Bot scheduled successfully for event ${event.id}`);
  } else {
    console.log(`INFO: Delete bot for event ${event.id}`);
    // delete the bot for the event. Recall will handle the case where the bot does not exist.
    updatedEventFromRecall = await Recall.removeBotFromCalendarEvent({
      id: event.recallId,
    });
  }

  // update event data returned from Recall
  if (updatedEventFromRecall) {
    event.recallData = updatedEventFromRecall;
    await event.save();
  }
};
