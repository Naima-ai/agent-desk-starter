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

/** Send an approved template. Templates must be pre-approved by Meta (24-48h). */
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
  const res = await fetch(`${BASE}/${PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`WA POST /messages -> ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { ok: true, to, template, live: true, id: data?.messages?.[0]?.id };
}
