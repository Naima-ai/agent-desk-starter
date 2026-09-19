// backend/connectors/fattureInCloud.mjs
// FIRST REAL CONNECTOR (example). Talks to the real Fatture in Cloud REST API
// (https://api-v2.fattureincloud.it) with an OAuth2 Bearer token.
// If no token is configured it falls back to a local stub so `npm start` still
// runs offline for the demo. Docs: https://developers.fattureincloud.it
const BASE = "https://api-v2.fattureincloud.it";
const TOKEN = process.env.FIC_ACCESS_TOKEN;      // OAuth2 access token
const COMPANY = process.env.FIC_COMPANY_ID;      // numeric company id
const LIVE = Boolean(TOKEN && COMPANY);

async function fic(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}/c/${COMPANY}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`FiC ${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** Read a received (supplier) document. Scope: received_documents:r */
export async function readInvoice(sdiId) {
  if (!LIVE) { console.warn("[FiC] no token — using offline stub for readInvoice"); return { sdiId, extracted: true, live: false }; }
  // GET /c/{company}/received_documents?type=expense&q=...
  const q = encodeURIComponent(`ei_raw.sdi_id = '${sdiId}'`);
  const data = await fic(`/received_documents?type=expense&q=${q}`);
  return { sdiId, live: true, ...data };
}

/** Create a received document with the resolved Chart-of-Accounts line.
 *  Scope: received_documents:a. Payload shape per API v2 received_documents. */
export async function postInvoice(invoice, account) {
  if (!LIVE) { console.warn("[FiC] no token — using offline stub for postInvoice"); return { ok: true, docId: `FIC-STUB-${Math.floor(Math.random()*9000+1000)}`, account, live: false }; }
  const payload = {
    data: {
      type: "expense",
      entity: { name: invoice.supplier },
      date: invoice.date,
      amount_net: invoice.net,
      amount_vat: invoice.total - invoice.net,
      // The CoA line goes on the item; refine the exact field with your studio's setup.
      items_list: invoice.lines.map((l) => ({ name: l.desc, net_price: l.amount, category: account })),
    },
  };
  const created = await fic(`/received_documents`, { method: "POST", body: payload });
  return { ok: true, docId: created?.data?.id, account, live: true };
}
