// tests/ingestion.test.mjs — proves the two previously-missing pipeline
// stages (Rulebook Section 3: Ingestion, Normalisation) actually work
// against real format diversity: XML, CSV, and Italian-labelled JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ingest, history, normaliseJsonRow, normaliseCsvRow, parseCsv, normaliseXmlDocument, splitXmlFeed,
} from "../backend/ingestion.mjs";

test("ingest captures real provenance metadata and a real content hash", () => {
  const rec = ingest({ source: "test", channel: "unit-test", clientId: "test_client_1", raw: "hello world", format: "json" });
  assert.ok(rec.id);
  assert.equal(rec.clientId, "test_client_1");
  assert.equal(rec.byteLength, 11);
  assert.match(rec.hash, /^[0-9a-f]{16}$/);
  assert.ok(rec.capturedAt);
  assert.ok(history("test_client_1").some((r) => r.id === rec.id));
});

test("ingest is content-addressed: identical raw payloads hash identically, different ones don't", () => {
  const a = ingest({ source: "t", channel: "t", clientId: "test_client_2", raw: "same", format: "json" });
  const b = ingest({ source: "t", channel: "t", clientId: "test_client_2", raw: "same", format: "json" });
  const c = ingest({ source: "t", channel: "t", clientId: "test_client_2", raw: "different", format: "json" });
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash);
});

test("normaliseJsonRow converts Italian decimal-comma numbers and DD/MM/YYYY dates", () => {
  const row = { id_riga: "L1", fornitore: "Test Srl", descrizione: "desc", imponibile: "1.234,56", iva: "271,60", conto: "60.10", affidabilita: 0.9, data_fattura: "05/08/2026" };
  const n = normaliseJsonRow(row);
  assert.equal(n.net, 1234.56);
  assert.equal(n.vat, 271.6);
  assert.equal(n.date, "2026-08-05");
});

test("normaliseCsvRow turns a genuinely empty date cell into null, not a guess", () => {
  const row = { id_riga: "L1", fornitore: "Test Srl", descrizione: "desc", imponibile: "100,00", iva: "22,00", conto: "60.10", affidabilita: "0.9", data_fattura: "" };
  const n = normaliseCsvRow(row);
  assert.equal(n.date, null);
  assert.equal(n.net, 100);
});

test("parseCsv splits a real CSV feed into header-keyed rows", () => {
  const csv = "id_riga,fornitore,imponibile\nL1,Test Srl,100,00\nL2,Other Srl,200,00";
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id_riga, "L1");
  assert.equal(rows[1].fornitore, "Other Srl");
});

test("parseCsv does not split a quoted field on the comma inside it (Italian-format numbers)", () => {
  // this is exactly the shape toRawCsv() produces for any amount, since
  // itNumber() always contains a comma and toRawCsv() quotes it for that reason
  const csv = 'id_riga,fornitore,imponibile,iva\nL1,Test Srl,"4500,00","990,00"';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].imponibile, "4500,00");
  assert.equal(rows[0].iva, "990,00");
  assert.equal(normaliseCsvRow(rows[0]).net, 4500);
  assert.equal(normaliseCsvRow(rows[0]).vat, 990);
});

test("normaliseXmlDocument extracts real fields from a FatturaPA-shaped document and vat round-trips correctly", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica><FatturaElettronicaHeader><CedentePrestatore><DatiAnagrafici>
<IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>12345678903</IdCodice></IdFiscaleIVA>
<Anagrafica><Denominazione>Test Supplier</Denominazione></Anagrafica>
</DatiAnagrafici></CedentePrestatore></FatturaElettronicaHeader>
<FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento>
<TipoDocumento>TD01</TipoDocumento><Data>2026-08-05</Data><Numero>FT-2026-Q3-L1</Numero>
</DatiGeneraliDocumento></DatiGenerali><DatiBeniServizi><DettaglioLinee>
<NumeroLinea>1</NumeroLinea><Descrizione>Test line</Descrizione>
<PrezzoTotale>300.00</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA>
</DettaglioLinee></DatiBeniServizi></FatturaElettronicaBody></p:FatturaElettronica>`;
  const n = normaliseXmlDocument(xml);
  assert.equal(n.supplier, "Test Supplier");
  assert.equal(n.net, 300);
  assert.equal(n.vat, 66); // 300 x 22%
  assert.equal(n.date, "2026-08-05");
  assert.equal(n.docType, "TD01");
  assert.equal(n.docNumber, "FT-2026-Q3-L1");
  assert.equal(n.lineNumber, 1);
  assert.equal(n.piva, "12345678903");
});

test("splitXmlFeed separates a multi-document feed back into individual documents", () => {
  const feed = "<doc>1</doc>\n<!-- ===NEXT-DOCUMENT=== -->\n<doc>2</doc>";
  const docs = splitXmlFeed(feed);
  assert.equal(docs.length, 2);
  assert.equal(docs[0], "<doc>1</doc>");
  assert.equal(docs[1], "<doc>2</doc>");
});
