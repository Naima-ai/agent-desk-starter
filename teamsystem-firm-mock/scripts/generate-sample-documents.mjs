// scripts/generate-sample-documents.mjs — one-off generator for realistic-looking
// sample XML/CSV invoices, written into ../sample-documents/. Reuses this repo's
// OWN real xmlGenerator.mjs / rawFeeds.mjs so the output is guaranteed to match
// exactly what addDocumentFromXml / addDocumentsFromCsv (adminActions.mjs) parse
// — these are meant to be uploaded through the mock's "Add documents" button.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toFatturaPaXml } from "../backend/xmlGenerator.mjs";
import { toRawCsv } from "../backend/rawFeeds.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "sample-documents");

// A fictional client the invoices are addressed to (matches the shape
// toFatturaPaXml expects: piva, name, regime, period).
const buyer = { id: "demo_buyer", name: "Rossi Srl", piva: "01234567897", regime: "ordinaria", period: "2026-Q3" };

// ---------------------------------------------------------------------------
// XML — three separate FatturaPA-shaped invoices, one file each (a real feed
// delivers one XML document per invoice, not a batch file).
// ---------------------------------------------------------------------------
const xmlInvoices = [
  {
    id: "L101", docNumber: "2026/0187", date: "2026-08-14",
    supplier: "Marchetti Consulenza e Revisione Srl", piva: "02345678904",
    desc: "Consulenza fiscale e revisione contabile — III trimestre 2026",
    net: 1850.0, vat: 407.0,
  },
  {
    id: "L102", docNumber: "FE-2026-00934", date: "2026-08-22",
    supplier: "EdilService Costruzioni Srl", piva: "03456789019",
    desc: "Manutenzione straordinaria impianto elettrico — sede operativa",
    net: 4200.0, vat: 924.0,
  },
  {
    id: "L103", docNumber: "0056/PA", date: "2026-09-02",
    supplier: "Bianchi Forniture per Ufficio Srl", piva: "04567890126",
    desc: "Fornitura cancelleria e materiale di consumo ufficio",
    net: 316.5, vat: 69.63,
  },
];

for (const inv of xmlInvoices) {
  const xml = toFatturaPaXml(buyer, { ...inv, lineNumber: 1 });
  const filename = `invoice_${inv.supplier.split(" ")[0].toLowerCase()}_${inv.docNumber.replace(/[^\w]/g, "-")}.xml`;
  await writeFile(join(outDir, "xml", filename), xml, "utf8");
  console.log("wrote", filename);
}

// ---------------------------------------------------------------------------
// CSV — one feed file with several rows, same columns + Italian number/date
// conventions (comma decimals, DD/MM/YYYY) a real gestionale export uses.
// ---------------------------------------------------------------------------
const csvClient = {
  lines: [
    { id: "L201", supplier: "Colombo Logistica e Trasporti Srl", desc: "Trasporto merci c/terzi — agosto 2026", net: 980.0, vat: 215.6, account: "60.10", confidence: 0.62, date: "2026-08-05" },
    { id: "L202", supplier: "Ferraro Impianti Srl", desc: "Manutenzione ordinaria impianto di climatizzazione", net: 540.0, vat: 118.8, account: "60.10", confidence: 0.9, date: "2026-08-11" },
    { id: "L203", supplier: "Studio Grafico Neri", desc: "Progettazione grafica catalogo prodotti 2026", net: 1200.0, vat: 264.0, account: null, confidence: 0.55, date: "2026-08-19" },
    { id: "L204", supplier: "Vitali Materiali Edili Srl", desc: "Fornitura materiali edili — cantiere via Garibaldi", net: 3150.75, vat: 693.17, account: "30.10", confidence: 0.95, date: "2026-08-27" },
  ],
};
const csv = toRawCsv(csvClient);
await writeFile(join(outDir, "csv", "supplier_feed_2026-Q3.csv"), csv, "utf8");
console.log("wrote supplier_feed_2026-Q3.csv");

// ---------------------------------------------------------------------------
// error-cases — deliberately broken documents, for exercising the validator
// against a real uploaded document instead of only the hardcoded seed data
// (e.g. Gamma Forniture Srl's bad P.IVA is baked into data/clients.mjs and
// can't be re-created via upload). addDocumentFromXml/addDocumentsFromCsv
// now extract `piva`, so FMT-03 fires on these when uploaded to any client.
// ---------------------------------------------------------------------------
await mkdir(join(outDir, "error-cases"), { recursive: true });

const badPivaXml = toFatturaPaXml(buyer, {
  id: "L301", docNumber: "2026/0501", date: "2026-09-10",
  supplier: "Sartori Trasporti Srl", piva: "05678901232", // check digit should be 1, not 2
  desc: "Trasporto merci conto terzi", net: 640.0, vat: 140.8, lineNumber: 1,
});
await writeFile(join(outDir, "error-cases", "bad_piva_invoice.xml"), badPivaXml, "utf8");
console.log("wrote bad_piva_invoice.xml (FMT-03 — check-digit fails)");

const badPivaCsv = toRawCsv({
  lines: [{ id: "L302", supplier: "Greco Manutenzioni Srl", desc: "Manutenzione ordinaria", net: 410.0, vat: 90.2, account: "60.10", confidence: 0.8, date: "2026-09-11" }],
}).split("\n");
badPivaCsv[0] += ",partita_iva";
badPivaCsv[1] += ",IT05678901232"; // same deliberately-wrong check digit, "IT"-prefixed this time
await writeFile(join(outDir, "error-cases", "bad_piva_feed.csv"), badPivaCsv.join("\n"), "utf8");
console.log("wrote bad_piva_feed.csv (FMT-03 — check-digit fails, via the optional partita_iva column)");

await mkdir(join(outDir, "pdf"), { recursive: true }); // kept for the PDF generator's output
console.log("done");
