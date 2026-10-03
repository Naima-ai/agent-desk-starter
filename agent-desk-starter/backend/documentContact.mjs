// backend/documentContact.mjs — chasing a missing document by hand.
// L'Amministrativo's automatic first ping asks the client owner on WhatsApp; this
// is the operator's own control over a pending request: pick the channel
// (email or WhatsApp), type the real recipient and message fields, send.
// Both channels go through the same connectors as everything else (email.mjs,
// whatsapp.mjs), so they are live or stubbed exactly as those are configured.
import { z } from "zod";
import { publish } from "./bus.mjs";
import * as evidence from "./memory/evidenceStore.mjs";
import * as email from "./connectors/email.mjs";
import * as wa from "./connectors/whatsapp.mjs";
import * as teamSystem from "./connectors/teamSystem.mjs";
import { pendingDocumentRequests } from "./lAmministrativo.mjs";

const emailAddr = z.string().trim().max(320).regex(/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/, "not a valid email address");
const phone = z.string().trim().regex(/^\+[1-9]\d{7,14}$/, "use international format, e.g. +393331234567");

export const ContactSchema = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("email"),
    to: emailAddr,
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20000),
    saveToClient: z.boolean().optional(),
  }).strict(),
  z.object({
    channel: z.literal("whatsapp"),
    to: phone,
    template: z.string().trim().regex(/^[a-z0-9_]{1,100}$/, "template names are lowercase letters, digits and underscores"),
    vars: z.record(z.string().max(200)).default({}),
    saveToClient: z.boolean().optional(),
  }).strict(),
]);

/** A pending request plus what the form needs to pre-fill itself. */
export async function describeRequest(r) {
  let contact = { name: null, email: null, phone: null };
  try {
    const m = await teamSystem.readMasterData(r.clientId);
    contact = { name: m.name || null, email: m.email || null, phone: m.phone || null };
  } catch { /* TeamSystem unreachable — the form simply starts empty */ }
  return {
    id: r.id, clientId: r.clientId, expected: r.expected, status: r.status,
    remindersSent: r.remindersSent, escalated: r.escalated, contact, contacts: r.contacts || [],
  };
}

export async function contactForRequest(requestId, rawInput) {
  const request = pendingDocumentRequests.get(requestId);
  if (!request || request.status !== "pending") return { status: 404, body: { error: "no such request, or already resolved" } };
  const parsed = ContactSchema.safeParse(rawInput);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; ") } };
  const input = parsed.data;

  let result;
  try {
    if (input.channel === "email") {
      result = await email.sendEmail({ clientId: request.clientId, to: input.to, subject: input.subject, text: input.body });
    } else {
      result = await wa.sendTemplate(input.to, input.template, input.vars);
    }
  } catch (e) {
    return { status: 502, body: { error: `${input.channel} send failed: ${e.message}` } };
  }

  const live = input.channel === "email" ? Boolean(result.live) : Boolean(result.live);
  const entry = { channel: input.channel, to: input.to, at: new Date().toISOString(), live, status: input.channel === "email" ? result.status : (live ? "sent" : "stub (not actually sent)") };
  (request.contacts ||= []).push(entry);

  const ev = evidence.put({ kind: "document_request_contact", client: request.clientId, requestId, ...entry });
  publish("evidence", { record: ev });
  publish("feed", {
    agent: "l_amministrativo", tone: live ? "good" : "info",
    text: `Chased ${request.expected.docType} ${request.expected.supplier} by ${input.channel} to ${input.to}${live ? "" : " (offline stub — nothing actually sent)"}.`,
  });

  let saved = null;
  if (input.saveToClient) {
    try {
      await teamSystem.updateClientContact(request.clientId, input.channel === "email" ? { email: input.to } : { phone: input.to });
      saved = true;
    } catch (e) { saved = `not saved to TeamSystem: ${e.message}`; }
  }
  return { status: 200, body: { ok: true, contact: entry, savedToClient: saved } };
}
