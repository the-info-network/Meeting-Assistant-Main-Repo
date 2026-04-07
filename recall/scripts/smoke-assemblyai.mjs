#!/usr/bin/env node
/**
 * Smoke test: AssemblyAI auth, LLM Gateway (Super Agent path), and pre-recorded transcript API.
 * Run from repo: cd recall && node scripts/smoke-assemblyai.mjs
 * Requires ASSEMBLYAI_API_KEY in .env or environment.
 */

import "dotenv/config";
import fetch from "node-fetch";

const API_KEY = process.env.ASSEMBLYAI_API_KEY?.trim();
const API_URL = (process.env.ASSEMBLYAI_API_URL || "https://api.assemblyai.com").replace(
  /\/+$/,
  ""
);
const LLM_BASE = (
  process.env.ASSEMBLYAI_LLM_GATEWAY_URL || "https://llm-gateway.assemblyai.com/v1"
).replace(/\/+$/, "");
const MODEL =
  process.env.ASSEMBLYAI_SUPER_AGENT_MODEL || "claude-sonnet-4-5-20250929";
/** Fallback if primary model returns 401 (e.g. LLM Gateway / LeMUR not on plan for Claude). */
const LLM_FALLBACK_MODEL = process.env.ASSEMBLYAI_SMOKE_LLM_FALLBACK || "gpt-4.1";

// Short public sample used in AssemblyAI docs / examples
const SAMPLE_AUDIO_URL =
  "https://storage.googleapis.com/aai-web-samples/5_common_sports_injuries.mp3";

function ok(name, detail) {
  console.log(`✓ ${name}${detail ? `: ${detail}` : ""}`);
}

function fail(name, err) {
  console.error(`✗ ${name}:`, err?.message || err);
  if (err?.body) console.error(String(err.body).slice(0, 500));
  const b = String(err?.body || "");
  if (b.includes("account is disabled")) {
    console.error(
      "\n  Fix: re-enable the AssemblyAI account or create a new API key at https://www.assemblyai.com/app/account"
    );
  }
  process.exitCode = 1;
}

async function main() {
  if (!API_KEY) {
    console.error("ASSEMBLYAI_API_KEY is not set. Add it to recall/.env or export it.");
    process.exit(1);
  }

  console.log("AssemblyAI smoke test");
  console.log(`  API: ${API_URL}`);
  console.log(`  LLM: ${LLM_BASE}`);
  console.log(`  Model (Super Agent): ${MODEL}\n`);

  // 1) Transcript API first — core product; works on standard transcription plans
  let transcriptId;
  try {
    const createRes = await fetch(`${API_URL}/v2/transcript`, {
      method: "POST",
      headers: {
        authorization: API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({ audio_url: SAMPLE_AUDIO_URL }),
    });
    const createText = await createRes.text();
    if (!createRes.ok) {
      const e = new Error(`HTTP ${createRes.status}`);
      e.body = createText;
      throw e;
    }
    const created = JSON.parse(createText);
    transcriptId = created?.id;
    if (!transcriptId) throw new Error("No transcript id in response");

    const deadline = Date.now() + 120_000;
    let status = created.status;
    let last = created;

    while (status !== "completed" && status !== "error" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const pollRes = await fetch(`${API_URL}/v2/transcript/${transcriptId}`, {
        headers: { authorization: API_KEY },
      });
      const pollText = await pollRes.text();
      if (!pollRes.ok) {
        const e = new Error(`Poll HTTP ${pollRes.status}`);
        e.body = pollText;
        throw e;
      }
      last = JSON.parse(pollText);
      status = last.status;
    }

    if (status === "error") {
      throw new Error(last.error || "Transcript failed");
    }
    if (status !== "completed") {
      throw new Error(`Timeout waiting for transcript (last status: ${status})`);
    }

    const text = (last.text || "").trim();
    if (text.length < 10) {
      throw new Error(`Transcript text too short (${text.length} chars)`);
    }
    ok("Transcript API (sample MP3)", `id=${transcriptId}, ${text.length} chars`);
  } catch (e) {
    fail("Transcript API", e);
    return;
  }

  // 2) LLM Gateway — same URL as generateSuperAgentSummary; may require LeMUR / gateway add-on for some models
  try {
    async function llmPing(model) {
      const llmRes = await fetch(`${LLM_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: API_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with exactly one word: pong" }],
          max_tokens: 16,
          temperature: 0,
        }),
      });
      const llmText = await llmRes.text();
      if (!llmRes.ok) {
        const e = new Error(`HTTP ${llmRes.status}`);
        e.body = llmText;
        throw e;
      }
      let llmJson;
      try {
        llmJson = JSON.parse(llmText);
      } catch {
        throw new Error(`Invalid JSON: ${llmText.slice(0, 200)}`);
      }
      const content = llmJson?.choices?.[0]?.message?.content?.trim() || "";
      if (!content) throw new Error("Empty LLM content");
      return { content, model };
    }

    let usedModel = MODEL;
    try {
      const { content } = await llmPing(MODEL);
      ok(`LLM Gateway (${MODEL})`, content.slice(0, 80));
    } catch (first) {
      if ((first.body || "").includes("LeMUR") || first.message?.includes("401")) {
        console.warn(
          `  (Primary model blocked: ${first.message}. Trying fallback ${LLM_FALLBACK_MODEL}…)`
        );
        const { content } = await llmPing(LLM_FALLBACK_MODEL);
        usedModel = LLM_FALLBACK_MODEL;
        ok(`LLM Gateway (${LLM_FALLBACK_MODEL}, fallback)`, content.slice(0, 80));
        console.warn(
          "  Note: Super Agent uses ASSEMBLYAI_SUPER_AGENT_MODEL; upgrade AssemblyAI for Claude on LLM Gateway or set a model your plan allows."
        );
      } else {
        throw first;
      }
    }
  } catch (e) {
    fail("LLM Gateway", e);
    return;
  }

  // 3) App module getTranscript (same code path as Super Agent complete)
  try {
    const mod = await import("../services/assemblyai/index.js");
    const AssemblyAI = mod.default;
    const fetched = await AssemblyAI.getTranscript(transcriptId);
    if (fetched?.status !== "completed") {
      throw new Error(`Expected completed, got ${fetched?.status}`);
    }
    const len = (fetched.text || "").trim().length;
    if (len < 10) throw new Error(`Service getTranscript text too short (${len})`);
    ok("App AssemblyAI.getTranscript", `${len} chars`);
  } catch (e) {
    fail("App AssemblyAI service", e);
    return;
  }

  console.log("\nAll AssemblyAI smoke checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
