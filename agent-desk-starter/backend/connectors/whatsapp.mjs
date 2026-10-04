// backend/connectors/whatsapp.mjs
// WhatsApp Business Cloud API (Meta). OUT: POST .../messages with a Bearer
// token. IN: Meta's webhook (see whatsappRoutes.mjs for the HTTP endpoint;
// ingestInbound() below is what actually processes one inbound message).
// Falls back to an offline stub when no token is set, so the demo still runs.
// Same shape and persistence style as the email channel (connectors/email.mjs) —
// append-only JSONL log, duplicate detection by provider message id, inbound
// only accepted from a sender TeamSystem can match to a client.
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { publish } from "../bus.mjs";
import * as evidence from "../memory/evidenceStore.mjs";
import * as teamSystem from "./teamSystem.mjs";

const VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v22.0";
const TOKEN = process.env.WHATSAPP_TOKEN;        // permanent System User token
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;  // WhatsApp phone number id
const LIVE = Boolean(TOKEN && PHONE_ID);
const BASE = `https://graph.facebook.com/${VERSION}`;

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "..", "data");
const logFile = () => process.env.WHATSAPP_LOG_FILE || join(dataDir, "whatsapp.jsonl");

export function status() {
  return {
    send: { live: LIVE, phoneId: PHONE_ID || null },
    receive: { webhookEnabled: Boolean(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) },
    mode: LIVE ? "live" : "offline stub",
  };
}

/**
 * Send an approved template. Templates must be pre-approved by Meta (24-48h).
 *
 * Never throws. A live failure (unapproved template, bad recipient, Meta
 * being down, etc.) is logged as a warning and returned as { ok: false, ... }
 * instead of crashing the caller — this matters most for calls made from a
 * timer (reminder/escalation ladders), where an uncaught throw has no scenario
 * or request context around it to catch it and previously took the whole
 * server down. Callers that care can still check `ok` and react; callers that
 * don't (most of the reminder-ladder call sites today) just keep going.
 */
export async function sendTemplate(to, template, vars = {}) {
  if (!LIVE) { console.warn("[WA] no token — using offline stub for sendTemplate"); return { ok: true, to, template, vars, live: false }; }

  const components = Object.keys(vars).length
    ? [{ type: "body", parameters: Object.values(vars).map((v) => ({ type: "text", text: String(v) })) }]
    : [];
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: { name: template, language: { code: "it" }, components },
  };

  try {
    const res = await fetch(`${BASE}/${PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[WA] send failed (${res.status}) for template "${template}" to ${to}: ${body}`);
      return { ok: false, to, template, live: true, status: res.status, error: body };
    }
    const data = await res.json();
    return { ok: true, to, template, live: true, id: data?.messages?.[0]?.id };
  } catch (err) {
    // Network-level failure (DNS, timeout, Meta unreachable) — same treatment.
    console.warn(`[WA] send failed (network error) for template "${template}" to ${to}: ${err.message}`);
    return { ok: false, to, template, live: true, error: err.message };
  }
}

// ---- message log (append-only JSONL, same persistence style as email.mjs / evidence) ----
function record(rec) {
  const full = { id: `wa_${randomUUID().slice(0, 8)}`, at: new Date().toISOString(), ...rec };
  mkdirSync(dirname(logFile()), { recursive: true });
  appendFileSync(logFile(), JSON.stringify(full) + "\n", "utf8");
  publish("whatsapp", { record: full });
  return full;
}
export function listMessages({ clientId, limit = 50 } = {}) {
  if (!existsSync(logFile())) return [];
  const rows = readFileSync(logFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return rows.filter((r) => !clientId || r.clientId === clientId).slice(-limit).reverse();
}
const alreadySeen = (messageId) => Boolean(messageId) && listMessages({ limit: 5000 }).some((r) => r.direction === "in" && r.messageId === messageId);

const feed = (text, tone = "info") => publish("feed", { agent: "l_amministrativo", text, tone });

/**
 * Process one inbound WhatsApp message, already parsed out of Meta's webhook
 * payload shape by whatsappRoutes.mjs. Only logs and matches the sender to a
 * client — it deliberately does NOT touch pendingDocumentRequests, pendingGates
 * etc. See backend/whatsappInbound.mjs for the part that decides what a reply
 * actually resolves; same split as documentContact.mjs vs this file on the
 * outbound side, so this connector stays dumb and reusable.
 */
export async function ingestInbound({ from, text, messageId, context }) {
  if (alreadySeen(messageId)) return { duplicate: true };
  const match = await teamSystem.findClientByPhone(from);
  const base = { direction: "in", from, text: String(text || "").slice(0, 4096), messageId: messageId || null, contextId: context?.id || null };

  if (!match) {
    const rec = record({ ...base, clientId: null, status: "unmatched sender" });
    feed(`WhatsApp message from ${from} ignored: not a number TeamSystem has on file for any client.`, "warn");
    return { matched: false, record: rec };
  }

  const rec = record({ ...base, clientId: match.id, status: "received" });
  const ev = evidence.put({ kind: "whatsapp_received", client: match.id, from, text: base.text });
  publish("evidence", { record: ev });
  feed(`WhatsApp from ${match.name} (${from}): "${base.text}"`, "good");
  return { matched: true, client: match, record: rec };
}
