// backend/scenario/vatFilingPath.mjs
// Drives the pre-filing validation demo end-to-end on mocks, emitting the events
// the UI renders. It begins in TeamSystem and ends at a human gate before the
// Agenzia delle Entrate — the agent never transmits by itself.
import { publish } from "../bus.mjs";
import * as evidence from "../memory/evidenceStore.mjs";
import { makeMessage } from "../../contracts/a2aSchema.mjs";
import { chartOfAccounts, period } from "../seed.mjs";
import { validateBatch } from "../validator.mjs";
import { classifyLine } from "../classifier.mjs";
import * as archivista from "../archivista.mjs";
import * as teamSystem from "../connectors/teamSystem.mjs";
import * as ade from "../connectors/adePortal.mjs";
import * as wa from "../connectors/whatsapp.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const a2a = (m) => publish("a2a", { message: makeMessage(m) });
const feed = (agent, text, tone = "info") => publish("feed", { agent, text, tone });

export async function runVatFilingPath() {
  publish("board", { step: "start", label: "Pre-filing validation started" });

  // 1 — TeamSystem compiles the periodic VAT/LIPE/F24 batch from the ledger.
  const vatBatch = await teamSystem.readVatBatch();
  const priorPeriod = await teamSystem.readPriorPeriod();
  feed("teamsystem", `TeamSystem compiled the ${vatBatch.kind} batch for ${period} from the ledger.`);
  publish("board", { step: "batch", label: `Batch ${period}: ${vatBatch.lines.length} lines` });
  await wait(600);

  // 2 — L'Addetto IVA validates completeness, coherence, prior periods & VAT rules.
  let received = [];
  let { tail, anomalies } = validateBatch(vatBatch, { receivedDocs: received, priorPeriod, taxonomy: chartOfAccounts });
  feed("l_addetto_iva", `Validated vs prior periods: ${tail.length} low-confidence line(s), ${anomalies.length} anomaly(ies).`,
       tail.length || anomalies.length ? "warn" : "good");
  publish("board", { step: "validated", label: `Tail: ${tail.length} · Anomalies: ${anomalies.length}` });
  await wait(700);

  // 3 — Solve the low-confidence tail (pre-fill): Il Classificatore.
  for (const line of tail) {
    const r = classifyLine(line);
    publish("coa", { supplier: line.supplier, account: r.account, confidence: r.confidence, options: chartOfAccounts });
    feed("il_classificatore", `Tail line ${line.id} (${line.supplier}) -> account ${r.account} @ conf ${r.confidence}.`);
    await wait(500);

    // 5 (memory) — low confidence -> ask once; confirmed at the gate -> rule saved.
    if (r.needsHuman) {
      publish("board", { step: "ask", label: `Line ${line.id}: low confidence — asking a human` });
      await wait(600);
      const ev = evidence.put({ kind: "tail_line", supplier: line.supplier, line: line.id, period });
      publish("evidence", { record: ev });
      const rule = archivista.learnConfirmed({
        key: `coa:${line.supplier}`, kind: "coa_mapping", scope: `client:${vatBatch.client}`,
        value: "60.10", confirmedBy: "Bianchi", evidenceId: ev.id,
      });
      publish("knowledge", { record: rule, note: "Rule confirmed at the gate and stored — auto-applied next period." });
      feed("l_archivista", `Rule saved to Cortex: ${line.supplier} -> 60.10 (conf 0.98). Tail shrinks next period.`, "good");
      await wait(600);
    }
  }

  // 4 — Act on each anomaly. A missing document goes through the client loop
  // (Smistatore -> L'Amministrativo -> back); a VAT-rule or prior-period
  // anomaly is a correction request instead (Rulebook Section 9.2) — the
  // record is held either way until it clears.
  for (const an of anomalies) {
    if (an.kind !== "item_missing") {
      feed("l_addetto_iva", `Anomaly (${an.ruleId}): ${an.message}`, "warn");
      publish("board", { step: "flagged", label: `${an.ruleId}: ${an.kind}` });
      const ev = evidence.put({ kind: "anomaly", ruleId: an.ruleId, detail: an, period });
      publish("evidence", { record: ev });
      feed("lo_smistatore", "Correction request queued for the client (template 9.2 — request for correction).", "info");
      await wait(600);
      continue;
    }

    a2a({ type: "instruction_from_studio", from: "lo_smistatore", to: "l_amministrativo", client: vatBatch.client,
          instruction: `fetch ${an.expected} for ${an.period}`, due: an.period });
    feed("lo_smistatore", `Anomaly routed to the client agent: ${an.expected}.`);
    await wait(600);

    feed("l_amministrativo", "Missing invoice not on file — asking the owner on WhatsApp.");
    await wa.sendTemplate("owner", "request_document", { doc: an.expected, period: an.period });
    await wait(600);

    const ev = evidence.put({ kind: "invoice", supplier: "Verdi Srl", period: an.period, sdiId: "IT" + Math.floor(Math.random()*900+100) });
    publish("evidence", { record: ev });
    a2a({ type: "document_delivered", from: "l_amministrativo", to: "lo_smistatore", client: vatBatch.client, doc: an.expected, sdiId: ev.sdiId });
    a2a({ type: "acknowledgment", from: "lo_smistatore", to: "l_amministrativo", client: vatBatch.client, ref: ev.sdiId });
    feed("l_addetto_iva", "Missing invoice received — re-inserted into the batch.", "good");
    // add the recovered line so the batch is now complete
    vatBatch.lines.push({ id: "L5", supplier: "Verdi Srl", desc: "Fornitura mensile", net: 600.0, vat: 132.0, account: "30.10", confidence: 0.95 });
    received.push({ supplier: "Verdi Srl", period: an.period });
    await wait(700);
  }

  // 6 — Re-assemble + prove; re-validate to show it now passes clean.
  const recheck = validateBatch(vatBatch, { receivedDocs: received, priorPeriod, taxonomy: chartOfAccounts });
  publish("board", { step: "reassembled", label: `Re-validated: tail ${recheck.tail.length}, anomalies ${recheck.anomalies.length}` });
  const prepared = await ade.prepareSubmission(vatBatch);
  feed("l_addetto_iva", `Batch re-assembled and pre-validated (${prepared.protocolDraft}). Ready for signature.`, "good");
  await wait(600);

  // 7 — Human gate: the agent REFUSES to transmit; the professional signs & sends.
  publish("board", { step: "gate", label: "Human gate — professional signs & sends to the Agenzia" });
  try {
    await ade.transmit(); // hard refusal, by design
  } catch (e) {
    feed("l_addetto_iva", String(e.message), "warn");
  }
  await wait(500);

  // write-back to TeamSystem (status + deadline) after the human has sent.
  await teamSystem.writeBack(period, vatBatch.client, "filed_pending_signature");
  publish("board", { step: "writeback", label: "Status + deadline written back into TeamSystem" });
  feed("teamsystem", "Filing status and closed deadline written back into TeamSystem.", "good");

  publish("board", { step: "done", label: "Pre-filing validation complete" });
  return { ok: true };
}
