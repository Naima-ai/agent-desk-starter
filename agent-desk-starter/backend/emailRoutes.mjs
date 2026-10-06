// backend/emailRoutes.mjs — the /api/email/* endpoints, kept out of server.mjs
// so the channel is one self-contained piece (same reason whatsapp.mjs is).
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import * as email from "./connectors/email.mjs";
import * as teamSystem from "./connectors/teamSystem.mjs";

export const PUBLIC_EMAIL_PATHS = ["/api/email/inbound"]; // has its own token check, see below

const json = (res, status, body) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));

const SendSchema = z.object({
  clientId: z.string().min(1).max(100),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20000),
}).strict();

const InboundSchema = z.object({
  from: z.string().min(3).max(320),
  subject: z.string().max(500).optional(),
  text: z.string().max(200000).optional(),
  messageId: z.string().max(500).optional(),
  attachments: z.array(z.object({
    filename: z.string().min(1).max(255),
    contentType: z.string().max(100).optional(),
    contentBase64: z.string(),
  })).max(20).default([]),
}).strict();

function tokenOk(req) {
  const expected = email.config().webhookToken;
  if (!expected) return { ok: false, status: 503, error: "inbound email webhook is disabled (EMAIL_WEBHOOK_TOKEN not set)" };
  const supplied = String(req.headers["x-webhook-token"] || String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? { ok: true } : { ok: false, status: 403, error: "bad webhook token" };
}

/** Returns true if it handled the request. */
export async function handleEmailRoute(req, res, url, readBody) {
  if (!url.pathname.startsWith("/api/email/")) return false;

  if (url.pathname === "/api/email/status" && req.method === "GET") { json(res, 200, email.status()); return true; }

  if (url.pathname === "/api/email/messages" && req.method === "GET") {
    json(res, 200, email.listMessages({ clientId: url.searchParams.get("client") || undefined, limit: Math.min(Number(url.searchParams.get("limit")) || 50, 200) }));
    return true;
  }

  if (url.pathname === "/api/email/poll" && req.method === "POST") { json(res, 200, await email.pollOnce()); return true; }

  if (url.pathname === "/api/email/send" && req.method === "POST") {
    const parsed = SendSchema.safeParse(JSON.parse((await readBody(req)) || "{}"));
    if (!parsed.success) { json(res, 400, { error: "invalid request", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }); return true; }
    const { clientId, subject, body } = parsed.data;
    const master = await teamSystem.readMasterData(clientId);
    if (!master || !master.email) { json(res, 502, { error: `no email address on file for client "${clientId}" (is the TeamSystem Firm mock running?)` }); return true; }
    try { json(res, 200, { ok: true, record: await email.sendEmail({ clientId, to: master.email, subject, text: body }) }); }
    catch (e) { json(res, 502, { error: e.message }); }
    return true;
  }

  // Provider webhook (Postmark/Mailgun/SendGrid-style "inbound parse", or a
  // forwarding script). Disabled unless EMAIL_WEBHOOK_TOKEN is set.
  if (url.pathname === "/api/email/inbound" && req.method === "POST") {
    const auth = tokenOk(req);
    if (!auth.ok) { json(res, auth.status, { error: auth.error }); return true; }
    const parsed = InboundSchema.safeParse(JSON.parse((await readBody(req)) || "{}"));
    if (!parsed.success) { json(res, 400, { error: "invalid request", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }); return true; }
    const d = parsed.data;
    const result = await email.ingestInbound({
      from: d.from, subject: d.subject, text: d.text, messageId: d.messageId,
      attachments: d.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.contentBase64, "base64") })),
    });
    json(res, 200, { ok: true, matched: result.matched ?? null, duplicate: Boolean(result.duplicate), attachments: result.record?.attachments || [] });
    return true;
  }

  json(res, 404, { error: "unknown email endpoint" });
  return true;
}
