// backend/connectors/whatsapp.mjs
// SECOND REAL CONNECTOR (example). WhatsApp Business Cloud API (Meta).
// POST https://graph.facebook.com/{version}/{phone_id}/messages with a Bearer token.
// Falls back to an offline stub when no token is set, so the demo still runs.
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
const VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v22.0";
const TOKEN = process.env.WHATSAPP_TOKEN;        // permanent System User token
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;  // WhatsApp phone number id
const LIVE = Boolean(TOKEN && PHONE_ID);
const BASE = `https://graph.facebook.com/${VERSION}`;

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
