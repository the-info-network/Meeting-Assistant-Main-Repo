import fetch from "node-fetch";

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const ASSEMBLYAI_API_URL = process.env.ASSEMBLYAI_API_URL || "https://api.assemblyai.com";
const ASSEMBLYAI_LLM_GATEWAY_URL =
  process.env.ASSEMBLYAI_LLM_GATEWAY_URL || "https://llm-gateway.assemblyai.com/v1";
/** Super Agent summary step; override if a model is deprecated or your account uses EU gateway docs. */
const ASSEMBLYAI_SUPER_AGENT_MODEL =
  process.env.ASSEMBLYAI_SUPER_AGENT_MODEL || "claude-sonnet-4-5-20250929";
/** Max chars sent to LLM for Super Agent (avoid context overflow / truncated JSON). */
const SUPER_AGENT_TRANSCRIPT_MAX_CHARS = Number.parseInt(
  process.env.ASSEMBLYAI_SUPER_AGENT_MAX_TRANSCRIPT_CHARS || "200000",
  10
);

async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const {
    retries = 2,
    backoffMs = 1000,
    retryStatuses = [429, 503, 504],
  } = retryOptions;

  let attempt = 0;
  while (true) {
    const response = await fetch(url, options);
    if (!retryStatuses.includes(response.status) || attempt >= retries) {
      return response;
    }
    const retryAfter = response.headers.get("retry-after");
    const waitMs = retryAfter
      ? Number.parseInt(retryAfter, 10) * 1000
      : backoffMs * Math.pow(2, attempt);
    await new Promise((resolve) => setTimeout(resolve, Number.isFinite(waitMs) ? waitMs : backoffMs));
    attempt += 1;
  }
}

/**
 * AssemblyAI Service
 * 
 * Provides transcript summarization using AssemblyAI's LLM Gateway
 * Supports multiple LLM providers through AssemblyAI's unified interface
 */
export default {
  async createTranscript(requestBody) {
    if (!ASSEMBLYAI_API_KEY) {
      throw new Error("ASSEMBLYAI_API_KEY is not configured");
    }

    const response = await fetchWithRetry(`${ASSEMBLYAI_API_URL}/v2/transcript`, {
      method: "POST",
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AssemblyAI transcript request failed (${response.status}): ${errorText || "unknown"}`);
    }

    return response.json();
  },

  async getTranscript(transcriptId) {
    if (!ASSEMBLYAI_API_KEY) {
      throw new Error("ASSEMBLYAI_API_KEY is not configured");
    }

    const response = await fetchWithRetry(`${ASSEMBLYAI_API_URL}/v2/transcript/${transcriptId}`, {
      method: "GET",
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AssemblyAI transcript fetch failed (${response.status}): ${errorText || "unknown"}`);
    }

    return response.json();
  },

  /** Plain text from AssemblyAI transcript payload (text, or utterances/words fallbacks). */
  getTranscriptPlainText(transcript) {
    const raw = transcript?.text;
    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw.trim();
    }
    const utterances = transcript?.utterances;
    if (Array.isArray(utterances) && utterances.length > 0) {
      const joined = utterances
        .map((u) => (u && typeof u.text === "string" ? u.text.trim() : ""))
        .filter(Boolean)
        .join("\n");
      if (joined.trim()) return joined.trim();
    }
    const words = transcript?.words;
    if (Array.isArray(words) && words.length > 0) {
      const w = words.map((x) => (x && typeof x.text === "string" ? x.text : "")).filter(Boolean).join(" ");
      if (w.trim()) return w.trim();
    }
    return "";
  },

  async uploadFromUrl(sourceUrl) {
    if (!ASSEMBLYAI_API_KEY) {
      throw new Error("ASSEMBLYAI_API_KEY is not configured");
    }

    const sourceResponse = await fetch(sourceUrl);
    if (!sourceResponse.ok || !sourceResponse.body) {
      throw new Error(`Failed to fetch source media (${sourceResponse.status}): ${sourceResponse.statusText}`);
    }

    const uploadResponse = await fetch(`${ASSEMBLYAI_API_URL}/v2/upload`, {
      method: "POST",
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
      },
      body: sourceResponse.body,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`AssemblyAI upload failed (${uploadResponse.status}): ${errorText || "unknown"}`);
    }

    const payload = await uploadResponse.json();
    return payload.upload_url;
  },

  async submitTranscript({ audioUrl, requestBody, allowUploadFallback = true }) {
    if (!audioUrl) {
      throw new Error("audioUrl is required to submit transcript");
    }

    const baseRequest = { ...requestBody, audio_url: audioUrl };

    try {
      const transcript = await this.createTranscript(baseRequest);
      return { transcript, requestBody: baseRequest };
    } catch (error) {
      if (!allowUploadFallback) {
        throw error;
      }

      const uploadUrl = await this.uploadFromUrl(audioUrl);
      const uploadRequest = { ...requestBody, audio_url: uploadUrl };
      const transcript = await this.createTranscript(uploadRequest);
      return { transcript, requestBody: uploadRequest };
    }
  },

  /**
   * Summarize transcript using AssemblyAI's LLM Gateway
   * @param {string} transcriptText - The transcript text to summarize
   * @param {Object} metadata - Meeting metadata (title, participants, etc.)
   * @param {Object} options - Configuration options
   * @param {string} options.model - LLM model to use (gpt-4, gpt-3.5-turbo, claude-3-opus, claude-3-sonnet, claude-3-haiku, gemini-pro)
   * @param {string} options.summaryType - Summary format (paragraph, bullets, headline)
   * @param {string} options.summaryModel - Summary style (informative, conversational)
   * @returns {Promise<Object>} Summary result with all requested fields
   */
  async summarizeTranscript(transcriptText, metadata = {}, options = {}) {
    if (!ASSEMBLYAI_API_KEY) {
      throw new Error("ASSEMBLYAI_API_KEY is not configured");
    }

    const {
      model = "gpt-4",
      summaryType = "bullets",
      summaryModel = "informative",
    } = options;

    const title = metadata?.title || "Meeting";
    const participants = metadata?.participants || [];
    const participantNames = Array.isArray(participants)
      ? participants.map(p => p.name || p.email || p).filter(Boolean).join(", ")
      : "";

    // Build comprehensive prompt for structured output
    const systemPrompt = `You are an expert meeting summarizer and analyst with deep expertise in extracting actionable insights from business conversations. Your summaries are used by busy professionals who need to quickly understand what happened and what needs to happen next.

Your task is to analyze the meeting transcript and produce comprehensive, well-structured outputs. Pay close attention to:
- WHO said what (use speaker names from the transcript)
- WHAT was decided vs. what was discussed
- SPECIFIC commitments and action items with owners
- CONTEXT and background that makes the summary useful

Return valid JSON with these fields:
1. summary: A comprehensive, well-structured summary that includes an executive overview (2-3 sentences), key discussion points with context, and important details. The summary should be immediately useful and scannable.
2. action_items: Array of specific tasks/assignments mentioned, each with 'task' (clear description), 'assignee' (person responsible if mentioned), and 'due_date' (if mentioned). Extract commitments made by specific speakers.
3. follow_ups: Array of suggested follow-up items and next steps, including any commitments or promises made during the meeting
4. topics: Array of main topics/themes discussed, each with 'title' (topic name) and 'items' (array of bullet points with details and timestamps if available)
5. highlights: Array of 5-10 concise bullets focused on decisions, outcomes, risks, or major updates. Each item should include: title (short), summary (1-2 sentences), speaker (who drove it), timestamp_seconds (number or null), category (decision|risk|update|action|note), impact (high|medium|low).
6. detailed_notes: Array of 8-15 paraphrased quote-style bullets. Each item: speaker, paraphrase (1-2 sentences capturing meaning), quote (short optional verbatim phrase), topic, timestamp_seconds (number or null), importance (high|medium|low). Prefer high-signal statements over filler.
7. stats: Object with lightweight stats. Include duration_seconds if inferable, and speakers: [{ name, talk_time_seconds, talk_time_percent, turns }]. If timing data is unclear, provide a reasonable estimate and note it is estimated.
8. sentiment: Object with 'score' (-1 to 1, negative to positive), 'label' (negative/neutral/positive), and 'confidence' (0-1). Consider overall tone, language used, and emotional indicators
9. key_insights: Array of key insights, innovative ideas, important realizations, or valuable suggestions from the meeting, each with 'insight' (the idea) and 'importance' (high/medium/low)
10. decisions: Array of decisions made during the meeting, each with 'decision' (what was decided) and 'context' (who made it and why). Distinguish between actual decisions and discussions
11. outcome: Overall meeting outcome - one of: 'productive' (clear progress made, goals achieved), 'inconclusive' (discussion without clear resolution), 'needs_followup' (requires additional meetings or actions), 'blocked' (progress blocked by issues), 'informational' (primarily information sharing)

Be thorough and accurate - this summary will be used to make important decisions.`;

    const userMessage = `Meeting Details:
Title: ${title}
Participants: ${participantNames || "Not specified"}
${metadata.durationSeconds ? `Estimated duration (seconds): ${metadata.durationSeconds}` : ""}

Transcript:
${transcriptText}

Please analyze this meeting transcript and provide a comprehensive summary with all requested outputs. Pay special attention to speaker attribution, specific commitments, and decisions made.`;

    try {
      // Use AssemblyAI's LLM Gateway endpoint for chat completions
      const response = await fetchWithRetry(`${ASSEMBLYAI_LLM_GATEWAY_URL}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: ASSEMBLYAI_API_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: model,
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: userMessage,
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.3,
          max_tokens: 8000,
        }),
      }, { retries: 2, backoffMs: 1500 });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[ASSEMBLYAI] API error (${response.status}):`, errorText);
        throw new Error(`AssemblyAI API failed (${response.status}): ${errorText || "unknown"}`);
      }

      const json = await response.json();
      // AssemblyAI LLM Gateway returns standard OpenAI-compatible format
      const content = json.choices?.[0]?.message?.content || json.response || json.text || "";

      if (!content) {
        throw new Error("AssemblyAI returned empty response");
      }

      // Parse JSON response
      let parsed;
      try {
        parsed = typeof content === "string" ? JSON.parse(content) : content;
      } catch (parseError) {
        console.error("[ASSEMBLYAI] Failed to parse JSON response:", parseError);
        throw new Error("AssemblyAI returned invalid JSON");
      }

      // Normalize response format to match expected structure
      return {
        source: "assemblyai",
        summary: parsed.summary || parsed.overview || "",
        actionItems: parsed.action_items || parsed.actionItems || parsed.actions || [],
        followUps: parsed.follow_ups || parsed.followUps || parsed.followups || [],
        topics: parsed.topics || parsed.key_points || [],
        highlights: parsed.highlights || parsed.highlight_bullets || [],
        detailedNotes: parsed.detailed_notes || parsed.detailedNotes || parsed.notes_detailed || [],
        stats: parsed.stats || null,
        sentiment: parsed.sentiment || { score: 0, label: "neutral", confidence: 0.5 },
        keyInsights: parsed.key_insights || parsed.keyInsights || [],
        decisions: parsed.decisions || [],
        outcome: parsed.outcome || "informational",
      };
    } catch (error) {
      console.error("[ASSEMBLYAI] Summarization error:", error);
      throw error;
    }
  },

  async generateSuperAgentSummary({ transcriptText, metadata = {}, chapters = [] }) {
    if (!ASSEMBLYAI_API_KEY) {
      throw new Error("ASSEMBLYAI_API_KEY is not configured");
    }

    let textForLlm = typeof transcriptText === "string" ? transcriptText : "";
    const maxChars = Number.isFinite(SUPER_AGENT_TRANSCRIPT_MAX_CHARS)
      ? SUPER_AGENT_TRANSCRIPT_MAX_CHARS
      : 200000;
    if (textForLlm.length > maxChars) {
      console.warn(
        `[ASSEMBLYAI] Super Agent transcript truncated for LLM: ${textForLlm.length} -> ${maxChars} chars`
      );
      textForLlm =
        textForLlm.slice(0, maxChars) +
        "\n\n[Transcript truncated for analysis. Earlier portion omitted.]";
    }

    const title = metadata?.title || "Meeting";
    const participants = metadata?.participants || [];
    const participantNames = Array.isArray(participants)
      ? participants.map(p => p.name || p.email || p).filter(Boolean).join(", ")
      : "";

    const chapterOutline = Array.isArray(chapters) && chapters.length > 0
      ? chapters
          .map((chapter, index) => {
            const headline = chapter.headline || chapter.gist || `Chapter ${index + 1}`;
            const start = typeof chapter.start === "number" ? Math.floor(chapter.start / 1000) : null;
            const end = typeof chapter.end === "number" ? Math.floor(chapter.end / 1000) : null;
            return `- ${headline}${start !== null ? ` (${start}s${end !== null ? `-${end}s` : ""})` : ""}: ${chapter.summary || ""}`;
          })
          .join("\n")
      : "No chapters available.";

    const systemPrompt = `You are an expert meeting analyst. Return valid JSON only.\n\nReturn fields:\n1. detailed_summary: A Fellow-style executive summary + detailed narrative.\n2. action_items: Array of { task, assignee, due_date }.\n3. decisions: Array of { decision, context }.\n4. highlights: Array of { title, summary, speaker, timestamp_seconds, category, impact }.\n5. key_insights: Array of { insight, importance }.\n6. outcome: One of productive|inconclusive|needs_followup|blocked|informational.`;

    const userMessage = `Meeting Details:\nTitle: ${title}\nParticipants: ${participantNames || "Not specified"}\n\nChapter Outline:\n${chapterOutline}\n\nTranscript:\n${textForLlm}\n\nProvide a comprehensive response in JSON that is actionable and detailed.`;

    const llmUrl = `${ASSEMBLYAI_LLM_GATEWAY_URL.replace(/\/$/, "")}/chat/completions`;
    const response = await fetchWithRetry(llmUrl, {
      method: "POST",
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ASSEMBLYAI_SUPER_AGENT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: 8192,
      }),
    }, { retries: 2, backoffMs: 1500 });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AssemblyAI LLM Gateway failed (${response.status}): ${errorText || "unknown"}`);
    }

    const json = await response.json();
    let content = json.choices?.[0]?.message?.content || "";
    const finishReason = json.choices?.[0]?.finish_reason;

    // Handle empty or truncated responses
    if (!content || content.trim() === "") {
      console.error("[AssemblyAI] LLM Gateway returned empty content, finishReason:", finishReason);
      throw new Error(`AssemblyAI LLM Gateway returned empty response (finish_reason: ${finishReason || "unknown"})`);
    }

    // Strip markdown code blocks if present (```json ... ``` or ``` ... ```)
    if (typeof content === "string") {
      content = content.trim();
      // Remove ```json or ``` at start
      if (content.startsWith("```json")) {
        content = content.slice(7);
      } else if (content.startsWith("```")) {
        content = content.slice(3);
      }
      // Remove ``` at end
      if (content.endsWith("```")) {
        content = content.slice(0, -3);
      }
      content = content.trim();
    }

    let parsed;
    try {
      parsed = typeof content === "string" ? JSON.parse(content) : content;
    } catch (parseError) {
      console.error("[AssemblyAI] Failed to parse LLM response as JSON:", parseError.message);
      console.error("[AssemblyAI] Content preview:", content?.substring?.(0, 500));
      throw new Error(`AssemblyAI LLM Gateway returned invalid JSON: ${parseError.message}`);
    }

    // Handle detailed_summary - it may be an object with executive_summary/detailed_narrative
    // or a plain string. The database expects a string.
    let detailedSummary = "";
    const rawSummary = parsed.detailed_summary || parsed.summary;
    if (typeof rawSummary === "string") {
      detailedSummary = rawSummary;
    } else if (rawSummary && typeof rawSummary === "object") {
      // Convert object format to string
      const parts = [];
      if (rawSummary.executive_summary) {
        parts.push(`**Executive Summary**\n${rawSummary.executive_summary}`);
      }
      if (rawSummary.detailed_narrative) {
        parts.push(`**Detailed Narrative**\n${rawSummary.detailed_narrative}`);
      }
      // Fallback: if object has other structure, stringify it nicely
      if (parts.length === 0) {
        detailedSummary = JSON.stringify(rawSummary, null, 2);
      } else {
        detailedSummary = parts.join("\n\n");
      }
    }

    return {
      detailedSummary,
      actionItems: parsed.action_items || [],
      decisions: parsed.decisions || [],
      highlights: parsed.highlights || [],
      keyInsights: parsed.key_insights || [],
      outcome: parsed.outcome || null,
    };
  },

  /**
   * Get available models from AssemblyAI
   * @returns {Array<string>} List of available model names
   */
  getAvailableModels() {
    return [
      "gpt-4",
      "gpt-4-turbo",
      "gpt-3.5-turbo",
      "claude-3-opus",
      "claude-3-sonnet",
      "claude-3-haiku",
      "gemini-pro",
    ];
  },
};
