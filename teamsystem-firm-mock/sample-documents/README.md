# Sample documents

Realistic-looking sample invoices for testing the mock's "Add documents" /
"Add account" upload feature (any client's detail page) by hand, without
having to write test XML/CSV/PDF from scratch each time.

All suppliers, addresses, P.IVA numbers, and logos here are fictional —
consistent with the rest of this mock's seed data (`backend/data/clients.mjs`).
Logos are simple programmatically-drawn monograms, not copies of any real
company's mark. **These are demo files only — not fiscally valid documents.**

- `xml/` — three FatturaPA-shaped invoices, one document each (matches what
  `addDocumentFromXml` in `backend/adminActions.mjs` parses: `PrezzoTotale`,
  `AliquotaIVA`, `Descrizione`, `Data`, supplier `Denominazione`).
- `csv/` — one supplier feed with 4 rows, same columns and Italian
  number/date conventions (`imponibile`, `iva` with comma decimals,
  `data_fattura` as DD/MM/YYYY) `addDocumentsFromCsv` expects.
- `pdf/` — three invoices with a letterhead logo, itemized table, and totals.
  Uploading one reads its TEXT LAYER (`pdf-parse`, no OCR) and — same as an
  XML/CSV upload — appends a new line (whole-document totals as one line,
  same convention as the XML path), *in addition to* saving the file itself
  as a supporting-evidence attachment. A scanned/image PDF, or any PDF that
  isn't shaped like this mock's own invoice layout, has no text layer (or an
  unrecognised one) to extract — it still saves fine as evidence, it just
  won't produce a line.
- `error-cases/` — deliberately broken documents, for testing that a real
  upload actually gets flagged, not just the hardcoded seed data:
  - `bad_piva_invoice.xml` / `bad_piva_feed.csv` / `bad_piva_invoice.pdf` —
    supplier P.IVA `05678901232`, whose real check digit should be `1`, not
    `2`. Upload any of the three to any client and re-run validation in
    Agent Desk — it should surface as an FMT-03 anomaly ("fails the
    check-digit validation"). The CSV version uses an optional
    `partita_iva` column (not part of the base feed shape in
    `rawFeeds.mjs`) to carry the P.IVA.

To construct your own error cases: copy any file in `xml/`/`csv/`/`pdf/` and
change a value — e.g. a `rate`/`AliquotaIVA` that doesn't match the target
account's chart-of-accounts rate triggers CST-04, a missing `PrezzoTotale`
triggers a parse failure (FMT-01). Whatever you change has to survive the
same extraction `addDocumentFromXml`/`addDocumentsFromCsv`/the PDF text
extractor do — see `backend/adminActions.mjs` for exactly which
tags/columns/text patterns are read. For a PDF specifically, editing
`scripts/generate_sample_pdfs.py`'s `draw_invoice()` calls and regenerating
is more reliable than hand-editing a PDF.

Regenerate them at any time with:

```bash
node scripts/generate-sample-documents.mjs   # xml/ + csv/ + error-cases/
python scripts/generate_sample_pdfs.py        # pdf/ (needs reportlab)
```

Both scripts reuse this repo's own `xmlGenerator.mjs` / `rawFeeds.mjs` where
possible, so the XML/CSV output is guaranteed to match what the real parsers
in `adminActions.mjs` accept — verified by feeding each file straight through
`addDocumentFromXml` / `addDocumentsFromCsv` before committing them here.
