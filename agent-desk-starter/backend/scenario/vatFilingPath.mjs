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
import * as La from "../lAmministrativo.mjs";
import lAmministrativoManifest from "../../contracts/seats/l_amministrativo.json" with { type: "json" };

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

  // 4 — Act on the anomaly: route through Lo Smistatore to the REAL L'Amministrativo.
  for (const an of anomalies) {
    a2a({ type: "instruction_from_studio", from: "lo_smistatore", to: "l_amministrativo", client: vatBatch.client,
          instruction: `fetch ${an.expected.replace(/^invoice\s+/, "")} for ${an.period}`, due: an.period });
    feed("lo_smistatore", `Anomaly routed to the client agent: ${an.expected}.`);
    await wait(600);

    // Checks the bank feed + SDI inbox first; 
    // if genuinely missing it opens a tracked request with its own reminder/escalation ladde.
    const result = await La.handleInstructionFromStudio(lAmministrativoManifest, vatBatch.client, {
      instruction: `fetch ${an.expected.replace(/^invoice\s+/, "")} for ${an.period}`,
    });

    if (result.ack) publish("a2a", { message: result.ack }); // acknowledged before any of the actual work below
    if (result.a2a) publish("a2a", { message: result.a2a });

    if (result.askedOwner) {
      feed("l_amministrativo", `Missing invoice not on file — asked the owner on WhatsApp (request ${result.requestId}).`);
      await wait(1200);
      // In the real flow this waits for the owner's WhatsApp reply or a later
      // SDI-inbox poll. The demo simulates the reply arriving here, but goes
      // through the real resolveDocumentRequest() path
      const sdiId = "IT" + Math.floor(Math.random() * 900 + 100);
      const resolved = La.resolveDocumentRequest(result.requestId, { foundVia: "owner_reply", sdiId });
      if (resolved) {
        publish("evidence", { record: resolved.evidence });
        publish("a2a", { message: resolved.a2a });
        a2a({ from: "lo_smistatore", to: "l_amministrativo", client: vatBatch.client, type: "acknowledgment", ref: sdiId });
      }
      feed("l_addetto_iva", "Missing invoice received — re-inserted into the batch.", "good");
      vatBatch.lines.push({ id: "L5", supplier: "Verdi Srl", desc: "Fornitura mensile", net: 600.0, vat: 132.0, account: "30.10", confidence: 0.95 });
      received.push({ supplier: "Verdi Srl", period: an.period });
    } else if (result.found) {
      feed("l_addetto_iva", "L'Amministrativo found the invoice on the client's own systems — no need to ask the owner.", "good");
      vatBatch.lines.push({ id: "L5", supplier: "Verdi Srl", desc: "Fornitura mensile", net: 600.0, vat: 132.0, account: "30.10", confidence: 0.95 });
      received.push({ supplier: "Verdi Srl", period: an.period });
    }
    await wait(700);
  }

  // 4c — Answer-from-memory demo
  const loggedExpense = await La.logAttendanceOrExpense(lAmministrativoManifest, vatBatch.client, {
    kind: "expense", id: "pranzo-cliente-rossi", amount: 42, note: "Pranzo di lavoro con il cliente",
  });
  if (loggedExpense.evidence) {
    publish("evidence", { record: loggedExpense.evidence });
    feed("l_amministrativo", "Logged a client expense (pranzo-cliente-rossi, €42) to its own client memory.");
    await wait(500);

    a2a({ type: "instruction_from_studio", from: "lo_smistatore", to: "l_amministrativo", client: vatBatch.client,
          instruction: "what was the pranzo-cliente-rossi expense?" });
    feed("lo_smistatore", "Studio asked about a specific expense.");
    await wait(500);

    const answered = await La.handleInstructionFromStudio(lAmministrativoManifest, vatBatch.client, {
      instruction: "what was the pranzo-cliente-rossi expense?",
    });
    if (answered.ack) publish("a2a", { message: answered.ack });
    if (answered.a2a) publish("a2a", { message: answered.a2a });
    feed("l_amministrativo",
      answered.answeredFromMemory
        ? "Already had this in its own memory — answered directly instead of escalating."
        : "Didn't recognise this from memory — escalated to the studio instead.",
      answered.answeredFromMemory ? "good" : "warn");
    await wait(600);
  }

  // 4d — Escalation demo
  a2a({ type: "instruction_from_studio", from: "lo_smistatore", to: "l_amministrativo", client: vatBatch.client,
        instruction: "what is the client's current ATECO code?" });
  feed("lo_smistatore", "Studio asked something this seat has no record of.");
  await wait(500);

  const escalated = await La.handleInstructionFromStudio(lAmministrativoManifest, vatBatch.client, {
    instruction: "what is the client's current ATECO code?",
  });
  if (escalated.ack) publish("a2a", { message: escalated.ack });
  if (escalated.a2a) publish("a2a", { message: escalated.a2a });
  feed("l_amministrativo",
    escalated.questionId
      ? `Doesn't know this — escalated to the studio rather than guessing (open question ${escalated.questionId}).`
      : "Unexpected: this should have escalated.",
    "warn");
  await wait(600);

  // 4e — Proactive delivery
  publish("board", { step: "pack", label: "L'Amministrativo assembles and delivers the monthly pack" });
  const packResult = await La.deliverMonthlyPack(vatBatch.client, period);
  publish("evidence", { record: packResult.evidence });
  publish("a2a", { message: packResult.a2a });
  feed("l_amministrativo",
    `Monthly pack delivered for ${period}: ${packResult.pack.docs.length} doc(s), ${packResult.pack.missing.length} still missing, ${packResult.pack.questions.length} open question(s).`,
    "good");
  await wait(700);

  // 4f — Owner-approval gate demo
  publish("board", { step: "gate_open", label: "L'Amministrativo: invoice drafted — waiting for owner approval" });
  let ticketId;
  const gatePromise = La.draftAndSendInvoice(lAmministrativoManifest, vatBatch.client, { customer: "Cliente Demo Srl", amount: 950 }, {
    onTicket: (ticket) => {
      ticketId = ticket.id;
      feed("l_amministrativo", `Invoice drafted for Cliente Demo Srl (€950) — owner approval required (gate ${ticket.id}).`, "warn");
      publish("gate", { id: ticket.id, clientId: vatBatch.client, action: ticket.action, payload: ticket.payload, status: "pending" });
    },
  });

  const outcome = await gatePromise.then((r) => ({ status: "approved", r })).catch((e) => ({ status: "denied", error: e.message }));
  feed("l_amministrativo", `Gate ${ticketId} resolved: ${outcome.status}.`, outcome.status === "approved" ? "good" : "warn");
  publish("gate", { id: ticketId, clientId: vatBatch.client, status: outcome.status });

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
