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
// Overridable only so tests can point it at a local fake Meta server.
const BASE = process.env.WHATSAPP_GRAPH_BASE_URL || `https://graph.facebook.com/${VERSION}`;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

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

/**
 * Send a plain text message. Meta only allows this inside the 24-hour window that
 * opens when the person last messaged us — fine for answering a reply they just
 * sent; anything business-initiated must still go through sendTemplate().
 * Never throws, same contract as sendTemplate.
 */
export async function sendText(to, body) {
  if (!LIVE) { console.warn("[WA] no token — using offline stub for sendText"); return { ok: true, to, live: false }; }
  try {
    const res = await fetch(`${BASE}/${PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn(`[WA] text send failed (${res.status}) to ${to}: ${err}`);
      return { ok: false, to, live: true, status: res.status, error: err };
    }
    const data = await res.json();
    return { ok: true, to, live: true, id: data?.messages?.[0]?.id };
  } catch (err) {
    console.warn(`[WA] text send failed (network error) to ${to}: ${err.message}`);
    return { ok: false, to, live: true, error: err.message };
  }
}

// ---- inbound media: Meta gives a media id; resolve it to a URL, then download with the token ----
async function downloadMedia(mediaId) {
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const metaRes = await fetch(`${BASE}/${encodeURIComponent(mediaId)}`, { headers: auth });
  if (!metaRes.ok) throw new Error(`media lookup ${metaRes.status}`);
  const meta = await metaRes.json();
  if (!meta.url) throw new Error("media lookup returned no url");
  if (Number(meta.file_size) > MAX_MEDIA_BYTES) throw new Error(`file larger than ${MAX_MEDIA_BYTES} bytes`);
  const fileRes = await fetch(meta.url, { headers: auth });
  if (!fileRes.ok) throw new Error(`media download ${fileRes.status}`);
  const content = Buffer.from(await fileRes.arrayBuffer());
  if (content.length > MAX_MEDIA_BYTES) throw new Error(`file larger than ${MAX_MEDIA_BYTES} bytes`);
  return { content, mimeType: meta.mime_type };
}

const EXT_BY_MIME = { "application/pdf": "pdf", "text/xml": "xml", "application/xml": "xml", "text/csv": "csv" };
function extFor(media) {
  const fromName = String(media.filename || "").split(".").pop().toLowerCase();
  if (["pdf", "xml", "csv"].includes(fromName)) return fromName;
  return EXT_BY_MIME[String(media.mimeType || "").split(";")[0].trim()] || null;
}

/** Download one inbound WhatsApp file and file it into the client's TeamSystem record —
 *  the same deliverInboundDocument() email attachments go through. `filed` is true only
 *  when TeamSystem actually stored it. */
async function fileMedia(clientId, media) {
  const ext = extFor(media);
  const filename = media.filename || `whatsapp_${media.id}${ext ? "." + ext : ""}`;
  if (!ext) {
    return { filename, filed: false, outcome: media.kind === "image"
      ? "not filed: a photo can't be read as an invoice (PDF or XML needed)"
      : "not filed: only PDF, XML and CSV are accepted" };
  }
  if (!LIVE) return { filename, filed: false, outcome: "not filed: WhatsApp not configured, can't download" };
  try {
    const { content } = await downloadMedia(media.id);
    const r = await teamSystem.deliverInboundDocument(clientId, { filename, ext, content });
    return { filename, filed: true, outcome: r.summary };
  } catch (e) {
    return { filename, filed: false, outcome: `not filed: ${e.message}` };
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
export async function ingestInbound({ from, text, messageId, context, media = null }) {
  if (alreadySeen(messageId)) return { duplicate: true };
  const match = await teamSystem.findClientByPhone(from);
  const base = {
    direction: "in", from, text: String(text || "").slice(0, 4096), messageId: messageId || null, contextId: context?.id || null,
    media: media ? { kind: media.kind, filename: media.filename || null, mimeType: media.mimeType || null } : null,
  };

  if (!match) {
    const rec = record({ ...base, clientId: null, status: "unmatched sender" });
    feed(`WhatsApp message from ${from} ignored: not a number TeamSystem has on file for any client.`, "warn");
    return { matched: false, record: rec };
  }

  // Files from an unknown sender are never downloaded (above); a known client's are
  // filed into their own TeamSystem record, same rule as email attachments.
  const documents = media ? [await fileMedia(match.id, media)] : [];
  const rec = record({ ...base, clientId: match.id, status: "received", documents });
  const ev = evidence.put({ kind: "whatsapp_received", client: match.id, from, text: base.text, documents: documents.map((d) => `${d.filename}: ${d.outcome}`) });
  publish("evidence", { record: ev });
  const docNote = documents.length ? ` — ${documents.map((d) => `${d.filename} -> ${d.outcome}`).join("; ")}` : "";
  feed(`WhatsApp from ${match.name} (${from}): "${base.text || (media ? `[${media.kind}]` : "")}"${docNote}`, documents.some((d) => !d.filed) ? "warn" : "good");
  return { matched: true, client: match, record: rec, documents };
}
