// backend/whatsappRoutes.mjs — the /api/whatsapp/* endpoints, kept out of
// server.mjs for the same reason emailRoutes.mjs is: one self-contained file
// per channel.
import { createHmac, timingSafeEqual } from "node:crypto";
import * as wa from "./connectors/whatsapp.mjs";
import { applyInboundReply } from "./whatsappInbound.mjs";

// Meta signs every webhook POST: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(raw body, App Secret).
// With WHATSAPP_APP_SECRET set, an unsigned or wrongly signed POST is rejected outright.
// Without it (local dev), POSTs are accepted but marked unverified, and an unverified
// reply is never allowed to decide an approval gate (see whatsappInbound.mjs).
export function verifySignature(rawBody, header, secret = process.env.WHATSAPP_APP_SECRET || "") {
  if (!secret) return { checked: false, ok: true };
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(String(header || "")), b = Buffer.from(expected);
  return { checked: true, ok: a.length === b.length && timingSafeEqual(a, b) };
}
let warnedUnsigned = false;

// Exempt from DESK_ACCESS_TOKEN because Meta can't send it; the GET handshake
// checks WHATSAPP_WEBHOOK_VERIFY_TOKEN instead. Unlike email's inbound webhook
// (POST only), Meta's verification step is a GET, so this one path declares
// both verbs explicitly. Every other public path in the app stays POST-only.
export const PUBLIC_WHATSAPP_PATHS = [{ path: "/api/whatsapp/webhook", methods: ["GET", "POST"] }];

const json = (res, status, body) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
const text = (res, status, body) => res.writeHead(status, { "Content-Type": "text/plain" }).end(body);

// Meta sends the sender's number as digits only, no "+". Our client
// directory / TeamSystem phone fields are E.164 ("+39..."), so normalize
// before any lookup or match.
function normalizePhone(raw) {
  const digits = String(raw || "").replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "";
}

/** Returns true if it handled the request. */
export async function handleWhatsAppRoute(req, res, url, readBody) {
  if (!url.pathname.startsWith("/api/whatsapp/")) return false;

  if (url.pathname === "/api/whatsapp/status" && req.method === "GET") { json(res, 200, wa.status()); return true; }

  if (url.pathname === "/api/whatsapp/messages" && req.method === "GET") {
    json(res, 200, wa.listMessages({ clientId: url.searchParams.get("client") || undefined, limit: Math.min(Number(url.searchParams.get("limit")) || 50, 200) }));
    return true;
  }

  // Meta's one-time verification handshake, fired when the webhook URL is
  // registered/changed in the dashboard. Respond with the raw challenge
  // string, plain text, if the mode + token match what we configured.
  if (url.pathname === "/api/whatsapp/webhook" && req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "";
    if (mode === "subscribe" && expected && token === expected) { text(res, 200, challenge || ""); return true; }
    text(res, 403, "verification failed");
    return true;
  }

  // Real event delivery. Meta requires a fast 200 regardless of what's
  // inside, or it will retry and eventually disable the webhook — so
  // nothing in here is allowed to throw back to Meta; any internal failure
  // is logged and still answered 200.
  if (url.pathname === "/api/whatsapp/webhook" && req.method === "POST") {
    const raw = (await readBody(req)) || "";
    const sig = verifySignature(raw, req.headers["x-hub-signature-256"]);
    if (!sig.ok) { json(res, 403, { error: "bad signature" }); return true; } // a forgery, not a Meta retry — refusing is correct here
    if (!sig.checked && !warnedUnsigned) {
      warnedUnsigned = true;
      console.warn("[WA webhook] WHATSAPP_APP_SECRET not set — accepting unsigned webhooks (dev only). Unsigned replies cannot approve or deny gates.");
    }
    try {
      const body = JSON.parse(raw || "{}");
      const changes = body?.entry?.flatMap((e) => e.changes || []) || [];
      for (const change of changes) {
        const messages = change?.value?.messages || [];
        for (const m of messages) {
          const from = normalizePhone(m.from);
          // Only plain text and button/quick-reply text are handled today —
          // images, documents, audio etc. are logged with empty text rather
          // than dropped outright, so there's still a record something arrived.
          const messageText = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? "";
          const ingestResult = await wa.ingestInbound({ from, text: messageText, messageId: m.id, context: m.context });
          if (ingestResult.matched) await applyInboundReply({ from, text: messageText, context: m.context, verified: sig.checked });
        }
      }
    } catch (e) {
      console.warn(`[WA webhook] failed to process inbound payload: ${e.message}`);
    }
    json(res, 200, { ok: true });
    return true;
  }

  json(res, 404, { error: "unknown whatsapp endpoint" });
  return true;
}
