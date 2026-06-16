/**
 * Build Recall.ai bot_config for adding a bot to a calendar event.
 *
 * Important details for transcription:
 * - Recall expects `recording_config.transcript.provider` to be an object keyed by provider name
 *   (e.g. { recallai_streaming: { mode: "prioritize_low_latency" } })
 * - For real-time transcript delivery, include `recording_config.realtime_endpoints` with events
 *   like `transcript.partial_data` / `transcript.data`.
 *
 * @param {Object} options
 * @param {Object} options.calendar - Calendar settings (provides defaults)
 * @param {Object} options.event - Optional CalendarEvent with per-meeting overrides
 * @param {string} options.publicUrl - Public URL for webhook endpoints
 */
function isPublicUrlSafeForRecall(url) {
  if (!url || typeof url !== "string") return false;
  const u = url.trim().toLowerCase();
  return (
    (u.startsWith("https://") || u.startsWith("http://")) &&
    !u.includes("localhost") &&
    !u.includes("127.0.0.1")
  );
}

export function buildBotConfig({ calendar, event, publicUrl }) {
  const botConfig = {};
  // Recall API returns 403 if payload contains localhost URLs; only send callbacks when URL is public
  const safePublicUrl = isPublicUrlSafeForRecall(publicUrl) ? publicUrl.replace(/\/$/, "") : null;
  if (publicUrl && !safePublicUrl) {
    console.log("[BOT_CONFIG] Skipping status_callback_url and realtime_endpoints (localhost/127.0.0.1 not allowed by Recall API); bot will still join.");
  }

  // Bot appearance
  if (calendar) {
    if (calendar.botName) {
      botConfig.bot_name = calendar.botName;
    }
    if (calendar.botAvatarUrl) {
      botConfig.bot_image = calendar.botAvatarUrl;
    }
  }

  // Recording config - specify output media types
  // Recall.ai requires explicit media type specifications, not just video/audio booleans
  botConfig.recording_config = {};

  if (calendar) {
    // Request video recording in MP4 format (mixed view of all participants)
    if (calendar.recordVideo !== false) {
      botConfig.recording_config.video_mixed_mp4 = {};
    }
    
    // Request audio recording in MP3 format (mixed audio of all participants)
    if (calendar.recordAudio !== false) {
      botConfig.recording_config.audio_mixed_mp3 = {};
    }
  } else {
    // Default: request both video and audio if no calendar settings
    botConfig.recording_config.video_mixed_mp4 = {};
    botConfig.recording_config.audio_mixed_mp3 = {};
  }

  // Transcription config
  if (calendar && calendar.enableTranscription !== false) {
    const languageCode =
      calendar.transcriptionLanguage && calendar.transcriptionLanguage !== "auto"
        ? calendar.transcriptionLanguage
        : null;

    // Determine transcription mode: event override takes precedence over calendar default
    // event.transcriptionMode can be 'realtime', 'async', or null (use calendar default)
    const effectiveTranscriptionMode = event?.transcriptionMode || calendar.transcriptionMode || "realtime";

    // Map our "realtime/async" UI to Recall provider config.
    // For real-time visibility in the UI/logs, prefer low-latency when language is compatible.
    const wantsRealtime = effectiveTranscriptionMode === "realtime";
    // Only use low-latency mode when language is explicitly English.
    // Omitting language_code lets Recall use the account default, which may be non-English
    // and would cause a 400 error with prioritize_low_latency.
    const providerMode =
      wantsRealtime && languageCode === "en"
        ? "prioritize_low_latency"
        : "prioritize_accuracy";

    // Use recallai_streaming as the provider (retell might not be available in all regions)
    const provider = {
      recallai_streaming: {
        mode: providerMode,
        ...(languageCode ? { language_code: languageCode } : {}),
      },
    };

    botConfig.recording_config.transcript = {
      provider,
    };

    // Request real-time delivery of transcript events to our webhook.
    // Without this, you typically won't receive streaming transcript events.
    if (wantsRealtime && safePublicUrl) {
      botConfig.recording_config.realtime_endpoints = [
        {
          type: "webhook",
          url: `${safePublicUrl}/webhooks/recall-notes`,
          events: [
            "transcript.partial_data",
            "transcript.data",
          ],
        },
      ];
    }
  }

  // Status callback URL - receives bot lifecycle events (recording.done, bot.status_change, etc.)
  // Omit when URL is localhost so Recall API accepts the request (403 otherwise); webhooks need a real PUBLIC_URL.
  if (safePublicUrl) {
    botConfig.status_callback_url = `${safePublicUrl}/webhooks/recall-notes`;
  }

  // Bot behavior settings and automatic_leave (required for bot_detection to be applied).
  // Recall API expects bot_detection INSIDE automatic_leave; top-level bot_detection is ignored.
  const botDetectionActivateAfter = 90;
  const botDetectionNamesTimeout = 10;

  // Use ONLY participant names for bot detection. Do NOT use using_participant_events.
  // Reason: Fireflies and other notetakers can emit active_speaker/screenshare events (or platforms
  // report them), which marks them as "real" participants. That blocks our bot from leaving when
  // only notetakers remain. Name-based detection is more reliable (per Recall docs).
  const botDetection = {
    using_participant_names: {
      matches: [
        "notetaker",
        "note taker",
        "recorder",
        "assistant",
        "bot",
        "otter",
        "otter.ai",
        "fireflies",
        "fireflies.ai",
        "read.ai",
        "read ai",
        "fathom",
        "grain",
        "gong",
        "chorus",
        "avoma",
        "meetgeek",
        "krisp",
        "sembly",
        "tactiq",
        "tl;dv",
        "tldv",
        "vowel",
        "airgram",
        "jamie",
        "supernormal",
        "fellow",
        "nylas",
        "circleback",
        "bluedot",
        "meetrecord",
        "claap",
        "rewatch",
        "loom",
        "recall",
      ],
      activate_after: botDetectionActivateAfter,
      timeout: botDetectionNamesTimeout,
    },
    // using_participant_events REMOVED: Fireflies/other notetakers can trigger active_speaker
    // events, which keeps our bot from leaving. Rely on participant names only.
  };

  botConfig.automatic_leave = {
    bot_detection: botDetection,
    ...(calendar?.autoLeaveIfAlone
      ? {
          waiting_room_timeout: calendar.autoLeaveAloneTimeoutSeconds || 60,
          noone_joined_timeout: calendar.autoLeaveAloneTimeoutSeconds || 60,
          everyone_left_timeout: calendar.autoLeaveAloneTimeoutSeconds || 60,
        }
      : {}),
  };

  return botConfig;
}
