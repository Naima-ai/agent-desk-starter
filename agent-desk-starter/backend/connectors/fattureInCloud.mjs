// backend/connectors/fattureInCloud.mjs
// FIRST REAL CONNECTOR (example). Talks to the real Fatture in Cloud REST API
// (https://api-v2.fattureincloud.it) with an OAuth2 Bearer token.
// If no token is configured it falls back to a local stub so `npm start` still
// runs offline for the demo. Docs: https://developers.fattureincloud.it
//
// Auth: OAuth2 Authorization Code flow. The access token is short-lived; the
// refresh token stays valid for a year as long as it's used at least that
// often (developers.fattureincloud.it/docs/basics/authentication/). This
// connector refreshes once on a 401 and gives up if that also fails.
//
// Rate limits: short bursts return 429 with a Retry-After header; this
// connector honours it with a single retry
// (developers.fattureincloud.it/docs/basics/limits-and-quotas/).
const BASE = "https://api-v2.fattureincloud.it";
const TOKEN_URL = `${BASE}/oauth/token`;

let accessToken = process.env.FIC_ACCESS_TOKEN;
const REFRESH_TOKEN = process.env.FIC_REFRESH_TOKEN;
const CLIENT_ID = process.env.FIC_CLIENT_ID;
const CLIENT_SECRET = process.env.FIC_CLIENT_SECRET;
const COMPANY = process.env.FIC_COMPANY_ID;
const LIVE = Boolean(accessToken && COMPANY);

/** Exchange the refresh token for a new access token.
 *  >>> TODO (real): persist the new access token somewhere durable (it
 *      currently only lives in this process's memory until the next restart). */
async function refreshAccessToken() {
  if (!REFRESH_TOKEN || !CLIENT_ID || !CLIENT_SECRET) return false;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: REFRESH_TOKEN, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  accessToken = data.access_token;
  return true;
}

async function fic(path, { method = "GET", body } = {}, _retried = false) {
  const res = await fetch(`${BASE}/c/${COMPANY}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !_retried && (await refreshAccessToken())) {
    return fic(path, { method, body }, true);
  }
  if (res.status === 429 && !_retried) {
    const waitMs = Number(res.headers.get("retry-after") || 2) * 1000;
    await new Promise((r) => setTimeout(r, waitMs));
    return fic(path, { method, body }, true);
  }
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

/** Look up a counterparty by name — resolving identity before posting (Rulebook
 *  SEM-03: a counterparty must resolve to a real, active registration).
 *  Scope: entity.clients:r */
export async function findEntity(name) {
  if (!LIVE) { console.warn("[FiC] no token — using offline stub for findEntity"); return { name, found: false, live: false }; }
  const q = encodeURIComponent(`name like '${name}'`);
  const data = await fic(`/entities/clients?q=${q}`);
  return { name, live: true, ...data };
}

/** NOTE — open question, flagged for the studio's own Fatture in Cloud setup:
 *  whether the resolved category belongs on the item line (as below) or on a
 *  separate cost-centre field depends on how their account is configured.
 *  Confirm before relying on this in production — the mapping lives in this
 *  one function, so it's a one-line fix either way once confirmed. */
function buildPayload(invoice, account) {
  return {
    data: {
      type: "expense",
      entity: { name: invoice.supplier },
      date: invoice.date,
      amount_net: invoice.net,
      amount_vat: invoice.total - invoice.net,
      items_list: invoice.lines.map((l) => ({ name: l.desc, net_price: l.amount, category: account })),
    },
  };
}

/** Create a received document with the resolved Chart-of-Accounts line.
 *  Scope: received_documents:a. Payload shape per API v2 received_documents. */
export async function postInvoice(invoice, account) {
  if (!LIVE) { console.warn("[FiC] no token — using offline stub for postInvoice"); return { ok: true, docId: `FIC-STUB-${Math.floor(Math.random()*9000+1000)}`, account, live: false }; }
  const created = await fic(`/received_documents`, { method: "POST", body: buildPayload(invoice, account) });
  return { ok: true, docId: created?.data?.id, account, live: true };
}
