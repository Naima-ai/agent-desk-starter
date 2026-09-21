// backend/adminActions.mjs — creating a new client at runtime, and adding
// real documents (XML / CSV / PDF) to any client, instead of the roster
// being fixed to the 10 built-in ones. New clients are pushed straight into
// the same `clients` array data.mjs already exports and everything else
// (listClients, getClient, /batch, /source) already reads from — no second
// data structure to keep in sync.
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PDFParse } from "pdf-parse";
import { clients } from "./data/clients.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const attachmentsDir = join(here, "attachments");

// The 10 built-in demo clients live only in data/clients.mjs (in-memory,
// reset to their curated edge-case state on every restart — deliberately,
// so the demo always has a known-clean baseline). A client created through
// "+ New client" has nothing designed about it, so losing it on every
// restart is just data loss, not a feature — this persists those (and
// everything later added to them: accounts, documents, attachments) to a
// small JSON file, the same pattern backend/memory/knowledgeStore.mjs
// already uses for learned rules.
const dataDir = join(here, "data");
const customClientsFile = join(dataDir, "custom-clients.json");
const customClientIds = new Set();

function loadCustomClients() {
  if (!existsSync(customClientsFile)) return;
  const saved = JSON.parse(readFileSync(customClientsFile, "utf8"));
  for (const c of saved) {
    if (!clients.some((existing) => existing.id === c.id)) clients.push(c);
    customClientIds.add(c.id);
  }
}
loadCustomClients();

function persistCustomClients() {
  mkdirSync(dataDir, { recursive: true });
  const saved = clients.filter((c) => customClientIds.has(c.id));
  writeFileSync(customClientsFile, JSON.stringify(saved, null, 2), "utf8");
}

function pivaCheckDigit(nineDigits) {
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const d = Number(nineDigits[i]);
    total += i % 2 === 0 ? d : (d * 2 > 9 ? d * 2 - 9 : d * 2);
  }
  return (10 - (total % 10)) % 10;
}
// A real Partita IVA is 11 bare digits, but it's routinely written with the
// "IT" country prefix (EU VAT-number format, e.g. "IT11234560123") — strip
// that before validating, or a genuinely valid number gets rejected by the
// digit-count regex before the check-digit math ever runs.
export function normalisePiva(piva) {
  return (piva || "").trim().toUpperCase().replace(/^IT/, "");
}
export function isValidPiva(piva) {
  const digits = normalisePiva(piva);
  if (!/^\d{11}$/.test(digits)) return false;
  return pivaCheckDigit(digits.slice(0, 10)) === Number(digits[10]);
}

function slugify(name) {
  return name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Create a new client. Returns { ok, client } or { ok: false, error }. */
export function createClient({ name, piva, codiceFiscale, ateco, regime, period, priorPeriod, sourceFormat }) {
  if (!name) return { ok: false, error: "name is required" };
  const normalisedPiva = piva ? normalisePiva(piva) : null;
  if (piva && !isValidPiva(piva)) {
    const reason = /^\d{11}$/.test(normalisedPiva)
      ? "check-digit fails"
      : `must be 11 digits (optionally prefixed "IT"), got ${normalisedPiva.length} characters after stripping any "IT" prefix`;
    return { ok: false, error: `"${piva}" is not a valid Partita IVA (${reason})` };
  }
  let id = slugify(name);
  if (!id) return { ok: false, error: "could not derive an id from that name" };
  if (clients.some((c) => c.id === id)) id = `${id}_${clients.length + 1}`;

  const client = {
    id, name, regime: regime || "ordinaria", sourceFormat: sourceFormat || "json",
    piva: normalisedPiva, codiceFiscale: codiceFiscale || normalisedPiva || null, ateco: ateco || null,
    edgeCase: "Added manually — not one of the 10 built-in demo cases.",
    chartOfAccounts: [], period: period || "2026-Q3", priorPeriod: priorPeriod || null,
    lines: [], expected: [], priorLines: [], attachments: [],
  };
  clients.push(client);
  customClientIds.add(client.id);
  persistCustomClients();
  return { ok: true, client };
}

/** Add a chart-of-accounts entry (needed before any line referencing that
 *  account can be validated for a rate/category mismatch). */
export function addAccount(client, { code, name, rate, natura }) {
  if (!code) return { ok: false, error: "code is required" };
  client.chartOfAccounts.push({ code, name: name || code, rate: rate ?? null, natura: natura ?? null });
  if (customClientIds.has(client.id)) persistCustomClients();
  return { ok: true };
}

// Seed data's line IDs aren't contiguous (e.g. Rossi Srl jumps L4 -> L6 -> L7
// because L5 is reserved for a line the demo script injects at runtime), so
// `lines.length + 1` can collide with an ID already in use. Take the actual
// highest numeric suffix in use instead.
function nextLineId(client) {
  const max = client.lines.reduce((m, l) => {
    const n = Number(String(l.id).replace(/^L/, ""));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return `L${max + 1}`;
}

/** Parse one FatturaPA-shaped XML document (the same shape our own
 *  generator produces) and append it as a new line. Same honest, non-XSD
 *  extraction approach as Agent Desk's own ingestion.mjs — good enough to
 *  prove a real document was received and read, not a full parser. */
export function addDocumentFromXml(client, xmlText) {
  const tag = (name) => { const m = xmlText.match(new RegExp(`<${name}>([^<]*)</${name}>`)); return m ? m[1] : null; };
  const cedente = xmlText.match(/<CedentePrestatore>[\s\S]*?<\/CedentePrestatore>/)?.[0] || "";
  const supplierMatch = cedente.match(/<Denominazione>([^<]*)<\/Denominazione>/);
  // The supplier's P.IVA (FMT-03) lives inside CedentePrestatore's own
  // IdFiscaleIVA/IdCodice — scoped to that block specifically, since
  // DatiTrasmissione has its own unrelated IdCodice earlier in the document
  // and a plain global match would grab the wrong one.
  const pivaMatch = cedente.match(/<IdFiscaleIVA>[\s\S]*?<IdCodice>([^<]*)<\/IdCodice>/);
  const net = tag("PrezzoTotale"); const rate = tag("AliquotaIVA");
  const netNum = net != null ? Number(net) : null;
  const rateNum = rate != null ? Number(rate) : null;
  if (netNum == null) return { ok: false, error: "couldn't find PrezzoTotale in this XML — not recognised as our FatturaPA shape" };
  const line = {
    id: nextLineId(client), supplier: supplierMatch ? supplierMatch[1] : "Unknown supplier",
    desc: tag("Descrizione") || "", net: netNum,
    vat: rateNum != null ? Math.round(netNum * (rateNum / 100) * 100) / 100 : 0,
    account: null, confidence: 0.5, // freshly arrived, unclassified — genuinely belongs in the tail
    date: tag("Data"), natura: tag("Natura") || undefined, docNumber: tag("Numero") || undefined,
    piva: pivaMatch ? pivaMatch[1] : undefined,
  };
  client.lines.push(line);
  if (customClientIds.has(client.id)) persistCustomClients();
  return { ok: true, line };
}

function parseCsvLine(line) {
  const out = []; let cur = ""; let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Parse a CSV feed in our own raw-feed shape (id_riga,fornitore,descrizione,
 *  imponibile,iva,conto,affidabilita,data_fattura) and append each row as a
 *  new line. `partita_iva` is an optional extra column (not part of the
 *  base export shape in rawFeeds.mjs) — include it to exercise FMT-03
 *  against an uploaded feed; rows without it just skip that check, same as
 *  seed lines that never carried a `piva` field. */
export function addDocumentsFromCsv(client, csvText) {
  const [headerLine, ...rows] = csvText.trim().split("\n");
  const headers = parseCsvLine(headerLine);
  const added = [];
  for (const row of rows.filter(Boolean)) {
    const values = parseCsvLine(row);
    const r = {}; headers.forEach((h, i) => { r[h] = values[i] ?? ""; });
    const net = r.imponibile ? Number(String(r.imponibile).replace(",", ".")) : null;
    const vat = r.iva ? Number(String(r.iva).replace(",", ".")) : null;
    if (net == null) continue;
    const line = {
      id: nextLineId(client), supplier: r.fornitore || "Unknown supplier", desc: r.descrizione || "",
      net, vat: vat ?? 0, account: r.conto || null, confidence: r.affidabilita ? Number(r.affidabilita) : 0.5,
      date: r.data_fattura ? (() => { const [d, m, y] = r.data_fattura.split("/"); return d && m && y ? `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}` : null; })() : null,
      piva: r.partita_iva || undefined,
    };
    client.lines.push(line);
    added.push(line);
  }
  if (customClientIds.has(client.id)) persistCustomClients();
  return { ok: true, added };
}

/** Extract a line from a PDF invoice's TEXT layer — same honest, "shaped
 *  like, not a universal parser" approach as addDocumentFromXml, just tuned
 *  to the layout scripts/generate_sample_pdfs.py produces (letterhead
 *  "P.IVA <11 digits>" before "FATTURATO A", then "Numero:"/"Data:", then
 *  "Imponibile"/"IVA" total lines). No OCR — a scanned/image-only PDF has no
 *  text layer to extract and will legitimately fail to recognise here.
 *  Returns null (not an error) when the PDF doesn't match that shape, so the
 *  caller can still keep it as an attachment even when no line comes of it. */
async function extractLineFromPdfText(client, pdfBuffer) {
  let text;
  try {
    const parser = new PDFParse({ data: pdfBuffer });
    const result = await parser.getText();
    await parser.destroy();
    text = result.text || "";
  } catch {
    return null; // not a readable/text-based PDF at all
  }

  // First "P.IVA <digits>" in the document is the issuer's, in the
  // letterhead — the buyer's own P.IVA appears later, under "FATTURATO A".
  const pivaMatch = text.match(/P\.IVA\s+(\d{11})/);
  const imponibileMatch = text.match(/^Imponibile\s*\S?\s*([\d.,]+)/m);
  const ivaMatch = text.match(/^IVA\s*\S?\s*([\d.,]+)/m);
  const itToNumber = (s) => (s ? Number(s.replace(/\./g, "").replace(",", ".")) : null);
  const net = itToNumber(imponibileMatch?.[1]);
  if (net == null) return null; // doesn't match this mock's invoice layout

  const numeroMatch = text.match(/Numero:\s*(\S+)/);
  const dataMatch = text.match(/Data:\s*(\d{2})\/(\d{2})\/(\d{4})/);
  const firstLine = (text.split("\n")[0] || "").trim();
  const supplier = firstLine.replace(/^[A-Z]{2}\s+/, "").trim() || "Unknown supplier";

  return {
    id: nextLineId(client), supplier,
    desc: `PDF invoice ${numeroMatch?.[1] || ""}`.trim(),
    net, vat: itToNumber(ivaMatch?.[1]) ?? 0,
    account: null, confidence: 0.5,
    date: dataMatch ? `${dataMatch[3]}-${dataMatch[2]}-${dataMatch[1]}` : null,
    docNumber: numeroMatch?.[1] || undefined,
    piva: pivaMatch ? pivaMatch[1] : undefined,
  };
}

/** Save a base64-encoded PDF as a real file, register it as an attachment,
 *  and — best-effort — extract a line from its text layer so a PDF upload
 *  can feed validation the same way an XML/CSV upload does. Extraction
 *  failing is NOT an error: plenty of real supporting documents (contracts,
 *  receipts, scans) are legitimately not one of this mock's invoice layouts
 *  and should still save as evidence. */
export async function addAttachment(client, { filename, contentBase64, kind, lineId }) {
  if (!filename || !contentBase64) return { ok: false, error: "filename and contentBase64 are required" };
  await mkdir(attachmentsDir, { recursive: true });
  const bytes = Buffer.from(contentBase64, "base64");
  const safeName = `${client.id}-${Date.now()}-${filename.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
  await writeFile(join(attachmentsDir, safeName), bytes);
  const docId = safeName.replace(/\.[^.]+$/, "");

  let extractedLine = null;
  if (/\.pdf$/i.test(filename)) {
    extractedLine = await extractLineFromPdfText(client, bytes);
    if (extractedLine) client.lines.push(extractedLine);
  }

  // Only one of the 10 seeded demo clients (data/clients.mjs) actually
  // pre-populates `attachments` — the rest have no such field at all, so
  // this was crashing the whole process on `undefined.push` for any other
  // client until this fallback was added.
  if (!client.attachments) client.attachments = [];
  client.attachments.push({ docId, kind: kind || "supporting_document", lineId: extractedLine?.id || lineId || null, filename: safeName });
  if (customClientIds.has(client.id)) persistCustomClients();
  return { ok: true, docId, line: extractedLine || undefined };
}
