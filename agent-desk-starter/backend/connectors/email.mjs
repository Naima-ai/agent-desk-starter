// backend/connectors/email.mjs
// Email channel between the studio and its clients — the email twin of
// whatsapp.mjs. OUT: SMTP (nodemailer). IN: IMAP polling (imapflow +
// mailparser) or a provider webhook (see emailRoutes.mjs). With no SMTP/IMAP
// settings it runs as an offline stub that records everything locally, so the
// demo and the tests work without a mailbox — exactly like the WhatsApp and
// Fatture in Cloud connectors.
//
// Safety rules baked in:
//  * Outbound goes ONLY to the address TeamSystem has on file for the client
//    (the caller passes it) — this is not an open relay.
//  * Inbound mail is accepted ONLY from a sender TeamSystem can match to a
//    client. Unknown senders are logged and their attachments dropped.
//  * Attachments: pdf / xml / csv only, size-capped, and stored through the
//    same TeamSystem endpoints the studio's own uploads use.
//  * Each inbound Message-ID is processed once (IMAP re-delivery / webhook retries).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { publish } from "../bus.mjs";
import * as evidence from "../memory/evidenceStore.mjs";
import * as teamSystem from "./teamSystem.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "..", "data");
const logFile = () => process.env.EMAIL_LOG_FILE || join(dataDir, "email.jsonl");

const ALLOWED_EXT = new Set(["pdf", "xml", "csv"]);
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);

/** Settings are read at call time (not import time) so .env loading order and tests can't bite. */
export function config() {
  const e = process.env;
  return {
    smtp: e.SMTP_HOST ? { host: e.SMTP_HOST, port: num(e.SMTP_PORT, 587), secure: e.SMTP_SECURE === "true", user: e.SMTP_USER || "", pass: e.SMTP_PASS || "" } : null,
    imap: e.IMAP_HOST && e.IMAP_USER ? { host: e.IMAP_HOST, port: num(e.IMAP_PORT, 993), secure: e.IMAP_SECURE !== "false", user: e.IMAP_USER, pass: e.IMAP_PASS || "" } : null,
    from: e.EMAIL_FROM || e.SMTP_USER || "studio@studio.example",
    pollSeconds: num(e.IMAP_POLL_SECONDS, 60),
    maxAttachmentBytes: num(e.EMAIL_MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024),
    webhookToken: e.EMAIL_WEBHOOK_TOKEN || "",
  };
}

export function status() {
  const c = config();
  return {
    send: { live: Boolean(c.smtp), host: c.smtp?.host || null, from: c.from },
    receive: { imapLive: Boolean(c.imap), imapHost: c.imap?.host || null, webhookEnabled: Boolean(c.webhookToken) },
    mode: c.smtp || c.imap ? "live" : "offline stub",
  };
}

// ---- message log (append-only JSONL, same persistence style as evidence) ----
function record(rec) {
  const full = { id: `em_${randomUUID().slice(0, 8)}`, at: new Date().toISOString(), ...rec };
  mkdirSync(dirname(logFile()), { recursive: true });
  appendFileSync(logFile(), JSON.stringify(full) + "\n", "utf8");
  publish("email", { record: full });
  return full;
}
export function listMessages({ clientId, limit = 50 } = {}) {
  if (!existsSync(logFile())) return [];
  const rows = readFileSync(logFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return rows.filter((r) => !clientId || r.clientId === clientId).slice(-limit).reverse();
}
const alreadySeen = (messageId) => Boolean(messageId) && listMessages({ limit: 5000 }).some((r) => r.direction === "in" && r.messageId === messageId);

const feed = (text, tone = "info") => publish("feed", { agent: "l_amministrativo", text, tone });
const addressOf = (s) => (/<([^>]+)>/.exec(String(s)) || [null, String(s)])[1].trim().toLowerCase();
const isEmail = (s) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s);
const oneLine = (s) => String(s).replace(/[\r\n]+/g, " ").trim();

// ---- OUT ----
let transporter = null;
export function resetTransport() { transporter = null; }

/** Send one email to a client. `to` must be the client's address on file. */
export async function sendEmail({ clientId, to, subject, text, attachments = [] }) {
  if (!isEmail(to)) throw new Error(`"${to}" is not a valid recipient address`);
  const subj = oneLine(subject || "").slice(0, 200);
  if (!subj) throw new Error("subject is required");
  if (!text || !String(text).trim()) throw new Error("body is required");
  const c = config();
  const base = { direction: "out", clientId: clientId || null, from: c.from, to, subject: subj, text: String(text), attachments: attachments.map((a) => ({ filename: a.filename, size: a.content?.length ?? 0 })) };

  if (!c.smtp) {
    console.warn("[Email] no SMTP settings — using offline stub for sendEmail");
    const rec = record({ ...base, status: "stub (not actually sent)", live: false });
    feed(`Email to ${to} recorded (offline stub — no SMTP configured): "${subj}"`);
    return rec;
  }
  try {
    if (!transporter) {
      const { default: nodemailer } = await import("nodemailer");
      transporter = nodemailer.createTransport({
        host: c.smtp.host, port: c.smtp.port, secure: c.smtp.secure,
        auth: c.smtp.user ? { user: c.smtp.user, pass: c.smtp.pass } : undefined,
      });
    }
    const info = await transporter.sendMail({ from: c.from, to, subject: subj, text: String(text), attachments: attachments.map((a) => ({ filename: a.filename, content: a.content })) });
    const rec = record({ ...base, status: "sent", live: true, messageId: info.messageId });
    feed(`Email sent to ${to}: "${subj}"`, "good");
    return rec;
  } catch (e) {
    const rec = record({ ...base, status: `failed: ${e.message}`, live: true });
    feed(`Email to ${to} FAILED: ${e.message}`, "warn");
    throw Object.assign(new Error(`SMTP send failed: ${e.message}`), { record: rec });
  }
}

// ---- IN ----
/** Process one received message. attachments: [{ filename, contentType, content: Buffer }] */
export async function ingestInbound({ from, subject, text, attachments = [], messageId }) {
  if (alreadySeen(messageId)) return { duplicate: true };
  const sender = addressOf(from);
  const c = config();
  const match = await teamSystem.findClientByEmail(sender);
  const base = { direction: "in", from: sender, to: c.from, subject: oneLine(subject || "(no subject)").slice(0, 200), text: String(text || "").slice(0, 20000), messageId: messageId || null };

  if (!match) {
    const rec = record({ ...base, clientId: null, status: "unmatched sender — attachments dropped", attachments: attachments.map((a) => ({ filename: a.filename, size: a.content?.length ?? 0, outcome: "dropped (unknown sender)" })) });
    feed(`Email from ${sender} ignored: not an address TeamSystem has on file for any client.`, "warn");
    return { matched: false, record: rec };
  }

  const results = [];
  for (const a of attachments) {
    const ext = String(a.filename || "").split(".").pop().toLowerCase();
    const size = a.content?.length ?? 0;
    const meta = { filename: a.filename, size };
    if (!ALLOWED_EXT.has(ext)) { results.push({ ...meta, outcome: "skipped: only pdf, xml and csv are accepted" }); continue; }
    if (size > c.maxAttachmentBytes) { results.push({ ...meta, outcome: `skipped: larger than ${c.maxAttachmentBytes} bytes` }); continue; }
    try {
      const r = await teamSystem.deliverInboundDocument(match.id, { filename: a.filename, ext, content: a.content });
      results.push({ ...meta, outcome: r.summary });
    } catch (e) { results.push({ ...meta, outcome: `failed: ${e.message}` }); }
  }

  const rec = record({ ...base, clientId: match.id, status: "received", attachments: results });
  const ev = evidence.put({ kind: "email_received", client: match.id, from: sender, subject: base.subject, attachments: results.map((r) => `${r.filename}: ${r.outcome}`) });
  publish("evidence", { record: ev });
  feed(`Email from ${match.name} (${sender}): "${base.subject}"${results.length ? ` — ${results.length} attachment(s): ${results.map((r) => `${r.filename} -> ${r.outcome}`).join("; ")}` : ""}`, "good");
  return { matched: true, client: match, record: rec };
}

// ---- IMAP poller ----
let polling = false;
let timer = null;
export async function pollOnce() {
  const c = config();
  if (!c.imap) return { polled: false, reason: "IMAP not configured" };
  if (polling) return { polled: false, reason: "a poll is already running" };
  polling = true;
  let processed = 0;
  try {
    const { ImapFlow } = await import("imapflow");
    const { simpleParser } = await import("mailparser");
    const imap = new ImapFlow({ host: c.imap.host, port: c.imap.port, secure: c.imap.secure, auth: { user: c.imap.user, pass: c.imap.pass }, logger: false });
    await imap.connect();
    const lock = await imap.getMailboxLock("INBOX");
    try {
      const uids = await imap.search({ seen: false }, { uid: true });
      for (const uid of uids) {
        const msg = await imap.fetchOne(uid, { source: true }, { uid: true });
        const mail = await simpleParser(msg.source);
        const result = await ingestInbound({
          from: mail.from?.value?.[0]?.address || "", subject: mail.subject, text: mail.text, messageId: mail.messageId,
          attachments: (mail.attachments || []).map((a) => ({ filename: a.filename || "attachment", contentType: a.contentType, content: a.content })),
        });
        // Only mail that belongs to a client is marked read. Everything else
        // (colleagues, newsletters...) is left exactly as it was, so pointing
        // this at a real inbox doesn't silently mark the owner's mail as read.
        if (result.matched) await imap.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
        processed += 1;
      }
    } finally { lock.release(); }
    await imap.logout();
    return { polled: true, processed };
  } catch (e) {
    feed(`Email inbox check failed: ${e.message}`, "warn");
    return { polled: false, reason: e.message };
  } finally { polling = false; }
}

export function startInboundPoller() {
  const c = config();
  if (!c.imap || timer) return false;
  timer = setInterval(() => { pollOnce().catch(() => {}); }, c.pollSeconds * 1000);
  timer.unref?.();
  pollOnce().catch(() => {});
  console.log(`[Email] polling ${c.imap.host} every ${c.pollSeconds}s for client mail`);
  return true;
}
