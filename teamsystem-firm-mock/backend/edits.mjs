// backend/edits.mjs — how the studio actually FIXES what validation found:
// edit a client's master data (name, email, Partita IVA, ATECO, regime...) or
// an invoice line (VAT amount, account, supplier P.IVA, date, wording...).
//
// Every change is validated, applied to the live client, written to an audit
// log (who, when, field, old value -> new value, why) and persisted, so the
// correction survives a restart and can be traced or reverted. The log IS the
// persistence: on startup it is replayed over the seed data.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getClient } from "./data/clients.mjs";
import { isValidPiva, normalisePiva, persistIfCustom } from "./adminActions.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const editsFile = process.env.TS_EDITS_FILE || join(process.env.TS_STATE_DIR || join(here, "data"), "edits.json");

let log = {}; // clientId -> [{ at, by, target, field, from, to, reason }]
function load() { try { if (existsSync(editsFile)) log = JSON.parse(readFileSync(editsFile, "utf8")); } catch { log = {}; } }
function persist() { mkdirSync(dirname(editsFile), { recursive: true }); writeFileSync(editsFile, JSON.stringify(log, null, 2), "utf8"); }

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const text = (max) => (v) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);
const money = (v) => { const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v; return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };
const bool = (v) => (typeof v === "boolean" ? v : null);

// Each validator returns the cleaned value, or null (invalid). `undefined` is a valid "clear this field".
const MASTER = {
  name: text(120),
  email: (v) => (typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? v.trim().toLowerCase() : null),
  piva: (v) => (isValidPiva(v) ? normalisePiva(v) : null),
  codiceFiscale: (v) => (typeof v === "string" && /^([0-9]{11}|[A-Za-z0-9]{16})$/.test(v.trim()) ? v.trim().toUpperCase() : null),
  ateco: (v) => (typeof v === "string" && /^\d{2}(\.\d{2}){0,2}$/.test(v.trim()) ? v.trim() : null),
  regime: (v) => (["ordinaria", "forfettario"].includes(v) ? v : null),
  phone: (v) => (v === "" ? undefined : typeof v === "string" && /^\+[1-9]\d{7,14}$/.test(v.trim()) ? v.trim() : null), // international format; used for WhatsApp
};
const LINE = {
  supplier: text(160), desc: text(300), net: money, vat: money, date: (v) => (typeof v === "string" && isDate(v) ? v : null),
  account: null, // checked against the chart below
  piva: (v) => (v === "" ? undefined : isValidPiva(v) ? normalisePiva(v) : null),
  natura: (v) => (v === "" ? undefined : typeof v === "string" && /^N[1-7](\.[1-9])?$/.test(v.trim()) ? v.trim() : null),
  legalWording: (v) => (v === "" ? undefined : text(200)(v)),
  splitPayment: bool, requiresEvidence: bool, evidenceAttached: bool,
};
const LABEL = { phone: "phone (international format, e.g. +393331234567)", piva: "Partita IVA", natura: "Natura (N1-N7)", date: "date (YYYY-MM-DD)", net: "net amount", vat: "VAT amount", email: "email address", ateco: "ATECO (e.g. 46.90.00)" };

function applyChanges(client, target, record, validators, changes, { by, reason }) {
  const errors = []; const staged = [];
  for (const [field, raw] of Object.entries(changes || {})) {
    if (!(field in validators)) { errors.push(`"${field}" cannot be edited`); continue; }
    let value;
    if (field === "account") {
      const code = typeof raw === "string" ? raw.trim() : "";
      value = client.chartOfAccounts.some((a) => a.code === code) ? code : null;
      if (value === null) errors.push(`account "${raw}" is not in this client's chart of accounts`);
      else staged.push([field, value]);
      continue;
    }
    value = validators[field](raw);
    if (value === null) { errors.push(`invalid ${LABEL[field] || field}: ${JSON.stringify(raw)}`); continue; }
    staged.push([field, value]);
  }
  if (errors.length) return { ok: false, error: errors.join("; ") };
  const entries = [];
  for (const [field, value] of staged) {
    const from = record[field];
    if (JSON.stringify(from) === JSON.stringify(value)) continue; // no-op
    if (value === undefined) delete record[field]; else record[field] = value;
    entries.push({ at: new Date().toISOString(), by: by || "studio", target, field, from: from === undefined ? null : from, to: value === undefined ? null : value, reason: reason || null });
  }
  if (entries.length) {
    (log[client.id] ||= []).push(...entries);
    persist(); persistIfCustom(client);
  }
  return { ok: true, changed: entries };
}

export function editClient(client, changes, meta = {}) {
  if ("piva" in (changes || {}) && !("codiceFiscale" in changes) && client.codiceFiscale === client.piva) {
    // sole traders/companies whose CF equals the P.IVA stay consistent unless told otherwise
    changes = { ...changes, codiceFiscale: normalisePiva(changes.piva) };
  }
  return applyChanges(client, "client", client, MASTER, changes, meta);
}

export function editLine(client, lineId, changes, meta = {}) {
  const line = client.lines.find((l) => l.id === lineId);
  if (!line) return { ok: false, status: 404, error: `no invoice line "${lineId}"` };
  return applyChanges(client, `line:${lineId}`, line, LINE, changes, meta);
}

export function getEditLog(clientId) { return (log[clientId] || []).slice().reverse(); }

/** Undo every edit for this client, restoring the original values. */
export function revertEdits(client) {
  const entries = log[client.id] || [];
  for (const e of entries.slice().reverse()) {
    const record = e.target === "client" ? client : client.lines.find((l) => `line:${l.id}` === e.target);
    if (!record) continue;
    if (e.from === null) delete record[e.field]; else record[e.field] = e.from;
  }
  delete log[client.id];
  persist(); persistIfCustom(client);
  return { ok: true, reverted: entries.length };
}

// Startup: replay saved edits over the seed data so corrections survive a restart.
load();
for (const [clientId, entries] of Object.entries(log)) {
  const client = getClient(clientId);
  if (!client) continue;
  for (const e of entries) {
    const record = e.target === "client" ? client : client.lines.find((l) => `line:${l.id}` === e.target);
    if (!record) continue;
    if (e.to === null) delete record[e.field]; else record[e.field] = e.to;
  }
}

/** Test hook. */
export function resetEditLog() { log = {}; persist(); }
