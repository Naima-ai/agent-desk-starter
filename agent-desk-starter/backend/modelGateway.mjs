/**
 * modelGateway.mjs
 * 
 * Unified Model Gateway for Loop Agent Desk.
 * - Primary: Sovereign Edge SLM (Qwen via Ollama localhost:11434)
 * - Secondary: Free Cloud Fallback (Google Gemini generateContent with Auth Key)
 * - Tertiary: Resilient heuristic fallback for offline development & tests
 */

import { z } from 'zod';

const LOCAL_SLM_URL = process.env.LOCAL_SLM_URL || 'http://localhost:11434/v1/chat/completions';
const LOCAL_SLM_MODEL = process.env.LOCAL_SLM_MODEL || 'qwen2.5:3b';

const FALLBACK_LLM_URL = process.env.FALLBACK_LLM_URL || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent';
// No hardcoded fallback key — a real, live-looking Gemini key was committed
// here directly in source (now revoked/rotated, ask whoever owns the
// Google AI Studio project). Credentials belong in .env (gitignored, see
// backend/loadEnv.mjs) or a real environment variable, never a literal in
// a file that's checked into git — that's permanent in history the moment
// it's pushed, private repo or not.
const FALLBACK_LLM_KEY = process.env.FALLBACK_LLM_KEY || process.env.GEMINI_API_KEY || '';

const DEFAULT_TIMEOUT_MS = Number(process.env.MODEL_GATEWAY_TIMEOUT_MS) || 20000;

/**
 * Main inference function used by compiler.mjs, classifier.mjs, and other agents.
 */
export async function askModel({
  prompt,
  systemPrompt = '',
  schema = null,
  temperature = 0.1
}) {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('modelGateway: prompt must be a non-empty string');
  }

  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  // 1. Try Local Edge SLM (Qwen via Ollama)
  try {
    const localResult = await callChatCompletion({
      url: LOCAL_SLM_URL,
      model: LOCAL_SLM_MODEL,
      messages,
      temperature,
      schema,
      timeoutMs: DEFAULT_TIMEOUT_MS
    });

    if (localResult) {
      console.log('>>> [GATEWAY] Tier 1 SUCCESS: Edge SLM responded');
      return parseOutput(localResult, schema);
    }
  } catch (err) {
    console.log('>>> [GATEWAY] Tier 1 (Edge SLM) bypassed:', err.message);
  }

  // 2. Try Cloud Fallback (Gemini with Auth Key)
  if (FALLBACK_LLM_KEY) {
    try {
      const fallbackResult = await callChatCompletion({
        url: FALLBACK_LLM_URL,
        model: 'gemini-flash-latest',
        apiKey: FALLBACK_LLM_KEY,
        messages,
        temperature,
        schema,
        timeoutMs: 15000
      });

      if (fallbackResult) {
        console.log('>>> [GATEWAY] Tier 2 SUCCESS: Cloud Fallback (Gemini) responded');
        return parseOutput(fallbackResult, schema);
      }
    } catch (err) {
      console.log('>>> [GATEWAY] Tier 2 (Cloud Fallback) failed:', err.message);
    }
  }

  // 3. Resilient Offline Heuristic Fallback
  console.log('>>> [GATEWAY] Tier 3 ACTIVE: Using Deterministic Heuristic');
  return getOfflineFallback({ prompt, systemPrompt, schema });
}

export async function getGatewayStatus() {
  // Tier 1 — is the local Ollama/Qwen server actually reachable right now?
  try {
    const probeUrl = LOCAL_SLM_URL.replace(/\/v1\/chat\/completions\/?$/, '/v1/models');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await fetch(probeUrl, { signal: controller.signal });
      if (res.ok) {
        return { tier: 'edge', label: `Local SLM (${LOCAL_SLM_MODEL})`, model: LOCAL_SLM_MODEL };
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Ollama not running / unreachable — fall through to the next tier.
  }

  // Tier 2 — no live edge model, but a cloud fallback key is configured.
  if (FALLBACK_LLM_KEY) {
    return { tier: 'cloud', label: 'Cloud Fallback (Gemini)', model: 'gemini-flash-latest' };
  }

  // Tier 3 — neither is available; askModel() would serve the deterministic
  // offline heuristic for every call right now.
  return { tier: 'offline', label: 'Offline Heuristic Fallback', model: null };
}

/**
 * Executes an HTTP POST against an OpenAI/Ollama endpoint or native Gemini REST endpoint.
 */
async function callChatCompletion({ url, model, apiKey, messages, temperature, schema, timeoutMs }) {
  const isGoogle = url.includes('generativelanguage.googleapis.com');
  const headers = { 'Content-Type': 'application/json' };

  let payload;

  if (isGoogle) {
    headers['X-goog-api-key'] = apiKey;

    const fullPrompt = messages.map(m => `${m.role ? m.role.toUpperCase() : 'USER'}: ${m.content}`).join('\n\n');
    payload = {
      contents: [
        {
          parts: [{ text: fullPrompt }]
        }
      ],
      generationConfig: {
        temperature,
        responseMimeType: schema ? 'application/json' : 'text/plain'
      }
    };
  } else {
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    payload = {
      model,
      messages,
      temperature,
      max_tokens: 1500
    };
    if (schema) {
      payload.response_format = { type: 'json_object' };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.log(`>>> [GATEWAY] POST returned ${res.status}: ${errText}`);
      return null;
    }

    const data = await res.json();

    if (isGoogle) {
      return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    }

    return data.choices?.[0]?.message?.content || null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Strips markdown formatting if present and validates against the provided Zod schema.
 */
function parseOutput(rawContent, schema) {
  const cleaned = rawContent
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (!schema) {
    return cleaned;
  }

  const parsedJson = JSON.parse(cleaned);
  return schema.parse(parsedJson);
}

/**
 * Provides deterministic structured fallback data when running offline.
 */
function getOfflineFallback({ prompt, schema }) {
  const lower = (prompt || '').toLowerCase();

  if (lower.includes('job description') || lower.includes('manifesto json') || lower.includes('manifest')) {
    const fallbackManifest = {
      seat: "l_addetto_iva",
      location: "studio_edge",
      model: { edge: "qwen3.5-4b", fallback: "kimi" },
      tools: ["teamsystem.read_vat_batch", "teamsystem.write_journal"],
      skills: [],
      memory: { read: [0, 1, 2, 3], write: [3] },
      refuses: ["transmit_to_authority", "sign_for_professional"],
      schedule: "event(teamsystem.vat_batch_ready)",
      gate: "human_review",
      artifact: "lipe_preview",
      unit: { per_batch: 40 }
    };
    return schema ? schema.parse(fallbackManifest) : JSON.stringify(fallbackManifest);
  }

  if (lower.includes('classifica') || lower.includes('fornitore:') || lower.includes('conto')) {
    let account = "60.10";
    let confidence = 0.90;

    if (lower.includes('hotel') || lower.includes('alberg') || lower.includes('trasfert') || lower.includes('soggiorno')) {
      account = "60.30";
      confidence = 0.94;
    } else if (lower.includes('enel') || lower.includes('utenza') || lower.includes('luce')) {
      account = "60.20";
      confidence = 0.95;
    } else if (lower.includes('cartoleria') || lower.includes('cancelleria')) {
      account = "70.05";
      confidence = 0.92;
    }

    const fallbackClassification = {
      account,
      confidence,
      reasoning: "Classificazione deterministica coerente con tassonomia CNDCEC."
    };
    return schema ? schema.parse(fallbackClassification) : JSON.stringify(fallbackClassification);
  }

  const defaultText = 'Offline model fallback response.';
  return schema ? { response: defaultText } : defaultText;
}

export default { askModel, getGatewayStatus };
