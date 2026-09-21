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

/** Read a received (supplier) document, matched by supplier name — confirmed
 *  against the real API: there's no usable "search by SDI id" filter field
 *  (that was tried and the API rejected it), but the plain list endpoint
 *  works and each document's `entity.name` is exactly what we already have
 *  on a batch line, so matching on that is the honest approach rather than a
 *  guessed query string. Scope: received_documents:r
 *  NOTE: this is a best-effort cross-check (teamSystem.mjs calls it once per
 *  line), not a hard requirement — a document genuinely not existing yet in
 *  Fatture in Cloud is the normal case, not a failure. Any error is caught
 *  and reported as not-found rather than thrown, so one bad lookup never
 *  takes down the whole batch — or the server, which is what happened
 *  before this was caught: an uncaught rejection here crashed the whole
 *  Node process mid-demo. */
export async function readInvoice(supplierName) {
  if (!LIVE) { console.warn("[FiC] no token — using offline stub for readInvoice"); return { supplierName, extracted: true, live: false }; }
  try {
    const data = await fic(`/received_documents?type=expense&fieldset=detailed`);
    const match = (data?.data || []).find((d) => d.entity?.name?.toLowerCase() === supplierName?.toLowerCase());
    return { supplierName, live: true, found: Boolean(match), document: match || null };
  } catch (e) {
    console.warn(`[FiC] readInvoice(${supplierName}) failed — treating as not found: ${e.message}`);
    return { supplierName, live: true, found: false, error: e.message };
  }
}

/** Look up a counterparty by name — resolving identity before posting (Rulebook
 *  SEM-03: a counterparty must resolve to a real, active registration).
 *  Scope: entity.clients:r */
export async function findEntity(name) {
  if (!LIVE) { console.warn("[FiC] no token — using offline stub for findEntity"); return { name, found: false, live: false }; }
  try {
    const q = encodeURIComponent(`name like '${name}'`);
    const data = await fic(`/entities/clients?q=${q}`);
    return { name, live: true, found: (data?.data || []).length > 0, ...data };
  } catch (e) {
    console.warn(`[FiC] findEntity(${name}) failed — treating as not found: ${e.message}`);
    return { name, live: true, found: false, error: e.message };
  }
}

/** The category question is resolved — confirmed empirically against the
 *  real API, not guessed: it's a plain top-level string field (`category`),
 *  not something nested on an item line. `items_list` isn't even required
 *  for a simple expense. `payments_list` IS required, though — the API
 *  rejects a document whose total doesn't reconcile against a payment
 *  schedule (error: "Il totale dei pagamenti non corrisponde al totale da
 *  pagare"), so a single payment for the full gross amount is included,
 *  due 30 days out. */
function buildPayload(invoice, account, categoryLabel) {
  const gross = Math.round((invoice.net + invoice.vat) * 100) / 100;
  const due = new Date(invoice.date ? new Date(invoice.date) : new Date());
  due.setDate(due.getDate() + 30);
  return {
    data: {
      type: "expense",
      entity: { name: invoice.supplier },
      date: invoice.date || new Date().toISOString().slice(0, 10),
      amount_net: invoice.net,
      amount_vat: invoice.vat,
      category: categoryLabel || account,
      payments_list: [{ amount: gross, due_date: due.toISOString().slice(0, 10) }],
    },
  };
}

/** Create a received document with the resolved Chart-of-Accounts line.
 *  Scope: received_documents:a. Payload shape confirmed against the real API
 *  (see buildPayload). `categoryLabel` is an optional human-readable label
 *  ("60.30 Alberghi e ristoranti") — falls back to the bare account code. */
export async function postInvoice(invoice, account, categoryLabel) {
  if (!LIVE) { console.warn("[FiC] no token — using offline stub for postInvoice"); return { ok: true, docId: `FIC-STUB-${Math.floor(Math.random()*9000+1000)}`, account, live: false }; }
  const created = await fic(`/received_documents`, { method: "POST", body: buildPayload(invoice, account, categoryLabel) });
  return { ok: true, docId: created?.data?.id, account, live: true };
}
