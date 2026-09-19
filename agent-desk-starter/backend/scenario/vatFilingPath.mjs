// backend/scenario/vatFilingPath.mjs
// Drives the pre-filing validation demo end-to-end on mocks, emitting the events
// the UI renders. It begins in TeamSystem and ends at a human gate before the
// Agenzia delle Entrate — the agent never transmits by itself.
import { publish } from "../bus.mjs";
import * as evidence from "../memory/evidenceStore.mjs";
import { makeMessage } from "../../contracts/a2aSchema.mjs";
import { vatBatch, chartOfAccounts, period } from "../seed.mjs";
import { validateBatch } from "../validator.mjs";
import { classifyLine, learn } from "../classifier.mjs";
import * as ade from "../connectors/adePortal.mjs";
import * as wa from "../connectors/whatsapp.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const a2a = (m) => publish("a2a", { message: makeMessage(m) });
const feed = (agent, text, tone = "info") => publish("feed", { agent, text, tone });

export async function runVatFilingPath() {
  publish("board", { step: "start", label: "Pre-filing validation started" });

  // 1 — TeamSystem compiled the periodic VAT/LIPE/F24 batch from the ledger.
  feed("teamsystem", `TeamSystem compiled the ${vatBatch.kind} batch for ${period} from the ledger.`);
  publish("board", { step: "batch", label: `Batch ${period}: ${vatBatch.lines.length} lines` });
  await wait(600);

  // 2 — L'Addetto IVA validates completeness & coherence -> tail + anomaly.
  let received = [];
  let { tail, anomalies } = validateBatch(vatBatch, received);
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
      const rule = learn(line, "60.10", "Bianchi", ev.id);
      publish("knowledge", { record: rule, note: "Rule confirmed at the gate and stored — auto-applied next period." });
      feed("l_archivista", `Rule saved to Cortex: ${line.supplier} -> 60.10 (conf 0.98). Tail shrinks next period.`, "good");
      await wait(600);
    }
  }

  // 4 — Act on the anomaly: the client loop (Smistatore -> L'Amministrativo -> back).
  for (const an of anomalies) {
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
  const recheck = validateBatch(vatBatch, received);
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
  publish("board", { step: "writeback", label: "Status + deadline written back into TeamSystem" });
  feed("teamsystem", "Filing status and closed deadline written back into TeamSystem.", "good");

  publish("board", { step: "done", label: "Pre-filing validation complete" });
  return { ok: true };
}
