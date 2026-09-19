# Agent Desk — demo starter (mock-first)

Loop × TeamSystem. A clickable, end-to-end demo that runs entirely on **mocks**.
Swap the mocks for real integrations to complete it. Nothing here touches real
client data, real credentials, or production systems.

The demo is the **pre-filing validation loop**: TeamSystem compiles the periodic
VAT / LIPE / F24 batch, the agents validate it, resolve the low-confidence tail,
chase the one anomaly through the client, learn the fix into memory — and then
**stop at a human gate** before the Agenzia delle Entrate. The agent never transmits.

## Run (2 commands)
```bash
npm install        # only dependency: zod
npm start          # serves http://localhost:5173
```
Open http://localhost:5173 and press **▶ Run demo**. The path plays across the
5 views: Roster, Agent page (compile a manifest), A2A stream, Board, Memory panel.

## The agents
- **Chief of Staff** — the only agent the human talks to. Compiles every other seat
  from its Job Description + Routine (`.md`) and reports performance. (`backend/compiler.mjs`)
- **IT Expert** — builds the connectors (TeamSystem, Fatture in Cloud, SDI, bank feed,
  AdE portal) and the technical tasks. (`backend/connectors/*`)
- **Demo seats:** `l_addetto_iva` (validates the batch), `il_classificatore` (pre-fills
  the tail), `l_amministrativo` (fetches the missing item at the client),
  `lo_smistatore` (routes the typed A2A), `l_archivista` (saves the rule to Cortex).

## The two contracts (source of truth)
- `contracts/manifestSchema.mjs` — the Agent Manifest schema.
- `contracts/a2aSchema.mjs` — the 8 typed A2A message types (+ signing stub).

Hand these two files to your coding tool as the contract when generating anything new.

## What is real vs mocked
- **Real & runnable:** contracts, the 7 seat manifests, the Job Card Compiler
  (validate + emit OpenClaw skill), the event bus, evidence + knowledge stores,
  the batch validator + classifier, the VAT-filing scenario, the 5-view UI, SSE streaming.
- **Real connectors (examples):** `connectors/fattureInCloud.mjs` (OAuth2) and
  `connectors/whatsapp.mjs` (Bearer). Set env vars to go live; otherwise offline stubs run.
- **Human-gated by design:** `connectors/adePortal.mjs` is **prepare-only** — its
  `transmit()` always throws. Transmission to the Agenzia is a human gate (the
  professional signs and sends). Enforced in the tool layer, not in a prompt.
- **Still mocked (`>>> TODO (real)`):** the bank feed, and the NL→manifest parse in the compiler.

## To complete (swap mocks for real)
1. `backend/compiler.mjs` → this is the **Chief of Staff**: replace `parseJobToManifest`
   with a real edge-SLM/LLM call over each seat’s Job Description + Routine, validated by `ManifestSchema`.
2. `backend/connectors/*` → the **IT Expert’s** job. FiC + WhatsApp are already real;
   wire the AdE portal (keep it prepare-only) and the bank feed, keeping the signatures.
3. `backend/bus.mjs` → Redis Streams / NATS. Enforce `refuses`/`gate` at the tool layer
   (security-critical — the AdE transmission must stay human-gated).
4. Memory → back the stores with LanceDB / memory-wiki; add real signing keys in
   `contracts/a2aSchema.mjs` (replace the sha256 stub).
5. Wire the edge SLM (Qwen3.5) + Kimi fallback; keep the frontend as-is (it only reads /events).

## Layout
```
contracts/         the two schemas + seats/*.json + *.job.txt  (7 seats)
backend/           compiler, bus, memory/, connectors/ (incl. adePortal), scenario/, server
                   validator.mjs (batch -> tail + anomaly) · classifier.mjs (tail line -> CoA)
frontend/          index.html (no-build React, 5 views)
```
