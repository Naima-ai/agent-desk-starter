// backend/scenario/vatFilingPath.mjs
// Drives the pre-filing validation demo end-to-end on mocks, emitting the events
// the UI renders. It begins in TeamSystem and ends at a human gate before the
// Agenzia delle Entrate — the agent never transmits by itself.
import { publish } from "../bus.mjs";
import * as evidence from "../memory/evidenceStore.mjs";
import * as clientMemory from "../memory/clientMemory.mjs";
import { makeMessage } from "../../contracts/a2aSchema.mjs";
import { validateBatch } from "../validator.mjs";
import { classifyLine } from "../classifier.mjs";
import { requestClassificationConfirmation } from "../classificationGate.mjs";
import * as archivista from "../archivista.mjs";
import * as teamSystem from "../connectors/teamSystem.mjs";
import * as ade from "../connectors/adePortal.mjs";
import * as La from "../lAmministrativo.mjs";
import { publishA2A } from "../messaging/a2aBus.mjs";
import { runAgent } from "../runtime/agentEngine.mjs";
import { startDefaultA2AConsumers, waitForA2AOutcome } from "../runtime/a2aConsumers.mjs";
import * as wa from "../connectors/whatsapp.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// How long a run waits for the owner's real WhatsApp reply before carrying on
// with the item still open. The request itself stays open afterwards: a later
// reply (or "Mark received" in Approvals) still closes it, then re-run Validate.
const OWNER_REPLY_TIMEOUT_MS = Number(process.env.WHATSAPP_REPLY_TIMEOUT_MS) || 5 * 60_000;

// Resolves "resolved" when the document request closes — by a WhatsApp reply
// (whatsappInbound.mjs) or the Approvals tab — or "timeout".
export function waitForDocumentRequest(requestId, timeoutMs) {
  if (!La.pendingDocumentRequests.has(requestId)) return Promise.resolve("resolved"); // closed before we started waiting
  return new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve("timeout"); }, timeoutMs);
    const off = La.onLadderEvent((e) => {
      if (e.kind === "document_request" && e.event === "resolved" && e.requestId === requestId) {
        clearTimeout(timer); off(); resolve("resolved");
      }
    });
  });
}
async function a2a(input) {
  const message = makeMessage(input);
  await publishA2A(message, { publisher: message.from });
  return message;
}
const feed = (agent, text, tone = "info") => publish("feed", { agent, text, tone });

/** The real Italian LIPE deadline: last day of the second month after the
 *  quarter ends (e.g. 2026-Q3 -> 30 Nov 2026). Used on the write-back so
 *  "the deadline" is an actual computed date, not a placeholder. */
function computeVatDeadline(periodId) {
  const m = /^(\d{4})-Q(\d)$/.exec(periodId || "");
  if (!m) return null;
  const year = Number(m[1]), quarter = Number(m[2]);
  const endMonth1Indexed = quarter * 3 + 2; // Q3 -> month 11 (November)
  const deadlineYear = year + Math.floor((endMonth1Indexed - 1) / 12);
  const normMonth = ((endMonth1Indexed - 1) % 12) + 1;
  const lastDay = new Date(deadlineYear, normMonth, 0).getDate(); // day 0 of next month = last day of this one
  return `${deadlineYear}-${String(normMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

/** A one-line, plain-language summary of an anomaly — the same sentence
 *  vatRules.mjs already writes into `message`, just without assuming the
 *  reader knows what a rule ID means. */
function describeAnomaly(an) {
  if (an.message) return an.message;
  if (an.kind === "item_missing" && an.expected) return `${an.expected} not received${an.period ? ` for ${an.period}` : ""}`;
  return `${an.kind.replace(/_/g, " ")}${an.supplier ? ` — ${an.supplier}` : ""}`;
}

export async function runVatFilingPath(clientId = "rossi_srl") {
  const run = clientMemory.beginRun(clientId);
  try {
    return await executeRun(clientId, run);
  } catch (e) {
    run.record("run_failed", { error: e.message });
    clientMemory.finishRun(run, { failed: true, error: e.message });
    throw e;
  }
}

async function executeRun(clientId, run) {
  await startDefaultA2AConsumers();
  publish("board", { step: "start", label: "Pre-filing validation started" });

  // Cortex memory, read FIRST: what the desk already knows about this client.
  const prior = run.prior;
  feed("l_archivista", prior.runs === 0
    ? `Cortex memory: first validation run for this client — no history yet, learning starts now.`
    : `Cortex memory: run #${prior.runs + 1} for this client. Last time: ${prior.last?.tail ?? "?"} low-confidence line(s), ${prior.last?.anomalies ?? "?"} problem(s); ${prior.rulesLearned} supplier rule(s) learned so far.`);

  // 1 — TeamSystem compiles the periodic VAT/LIPE/F24 batch from the ledger,
  // and hands over the client's master data + chart of accounts (the
  // rate<->category table) alongside it — all three come from the
  // TeamSystem Firm mock now, not a direct import of one fixture client.
  const master = await teamSystem.readMasterData(clientId);
  const vatBatch = await teamSystem.readVatBatch(clientId);
  const priorPeriod = await teamSystem.readPriorPeriod(clientId);
  const chartOfAccounts = await teamSystem.readChartOfAccounts(clientId);
  const period = vatBatch.period;
  run.period = period;
  run.record("batch_fetched", { client: master.name, lines: vatBatch.lines.length, kind: vatBatch.kind });
  feed("teamsystem", `TeamSystem compiled the ${vatBatch.kind} batch for ${master.name} (${period}) from the ledger.`);
  publish("board", { step: "batch", label: `${master.name} — batch ${period}: ${vatBatch.lines.length} lines` });
  await wait(600);

  // 2 — L'Addetto IVA validates completeness, coherence, prior periods & VAT rules.
  // An expected invoice counts as received when the period's batch already holds a
  // line from that supplier — e.g. the owner's document, filed in TeamSystem on an
  // earlier run. Starting from an empty list asked the owner again, every run, for
  // an invoice TeamSystem already had.
  const sameSupplier = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
  let received = (vatBatch.expected || [])
    .filter((e) => vatBatch.lines.some((l) => sameSupplier(l.supplier, e.supplier)))
    .map((e) => ({ supplier: e.supplier, period: e.period }));
  let { tail, anomalies } = validateBatch(vatBatch, { receivedDocs: received, priorPeriod, taxonomy: chartOfAccounts, vatGroup: master.vatGroup, formatAnomalies: vatBatch.formatAnomalies });
  const initialTail = tail.length, initialAnomalies = anomalies.length;
  run.record("validated", { tail: initialTail, anomalies: initialAnomalies, rules: anomalies.map((a) => a.ruleId) });
  feed("l_addetto_iva", `Validated vs prior periods: ${tail.length} low-confidence line(s), ${anomalies.length} anomaly(ies).`,
       tail.length || anomalies.length ? "warn" : "good");
  publish("board", {
    step: "validated",
    label: (tail.length === 0 && anomalies.length === 0)
      ? "Checked — everything looks correct, nothing needs attention"
      : `Checked — ${tail.length ? `${tail.length} line${tail.length === 1 ? "" : "s"} need${tail.length === 1 ? "s" : ""} a category` : ""}${tail.length && anomalies.length ? ", " : ""}${anomalies.length ? `${anomalies.length} problem${anomalies.length === 1 ? "" : "s"} found` : ""}`,
  });
  await wait(700);

  // 3 — Solve the low-confidence tail (pre-fill): Il Classificatore.
  for (const line of tail) {
    const r = await classifyLine(line, vatBatch.client, chartOfAccounts);
    run.record("classified", { line: line.id, supplier: line.supplier, account: r.account, confidence: r.confidence, source: r.source, needsHuman: r.needsHuman });
    publish("coa", { supplier: line.supplier, account: r.account, confidence: r.confidence, source: r.source, needsHuman: r.needsHuman, options: chartOfAccounts });
    // r.source is otherwise invisible in the UI — memory (a rule already
    // learned for this client+supplier), slm (a real modelGateway.mjs call —
    // Meet's classifier work), or heuristic (the plain keyword fallback, only
    // reached if the model call itself throws) all produce the exact same
    // "-> account @ conf" shape, so without this label there was no visible
    // way to tell which one actually ran.
    const sourceLabel = { memory: "remembered rule", slm: "model call", heuristic: "keyword fallback" }[r.source] || r.source;
    feed("il_classificatore", `Tail line ${line.id} (${line.supplier}) -> account ${r.account} @ conf ${r.confidence} (via ${sourceLabel}).`);
    if (!r.needsHuman) { line.account = r.account; line.confidence = r.confidence; }
    await wait(500);

// 5 (memory) — low confidence -> a REAL gate: the run pauses here until a
// human actually approves or denies it via POST /api/gate/:id/approve|deny
// (same mechanism as the invoice-approval gate below) — confirmed at the
// gate -> rule saved, under whoever's name actually approved it.
    if (r.needsHuman) {
      publish("board", { step: "ask", label: `Line ${line.id}: low confidence — waiting for a human to confirm ${r.account}` });
      const ev = evidence.put({ kind: "tail_line", supplier: line.supplier, line: line.id, period });
      publish("evidence", { record: ev });

      const gate = requestClassificationConfirmation(vatBatch.client, line, r);
      publish("gate", { id: gate.id, clientId: vatBatch.client, action: gate.action, payload: gate.payload, status: "pending" });
      feed("il_classificatore", `Waiting for a human to confirm ${line.supplier} -> ${r.account} (gate ${gate.id}).`, "warn");

      const outcome = await gate.decision.then((d) => ({ approved: true, ...d })).catch((e) => ({ approved: false, error: e.message }));
      publish("gate", { id: gate.id, clientId: vatBatch.client, status: outcome.approved ? "approved" : "denied" });
      run.record("gate_decision", { line: line.id, supplier: line.supplier, approved: outcome.approved, account: outcome.account || null, approvedBy: outcome.approvedBy || null });

      if (!outcome.approved) {
        feed("l_archivista", `Classification for ${line.supplier} was declined — stays unclassified in the tail.`, "warn");
        await wait(400);
        continue;
      }

      const rule = archivista.learnConfirmed({
        key: `client:${vatBatch.client}:coa:${line.supplier}`, kind: "coa_mapping", scope: `client:${vatBatch.client}`,
        value: outcome.account, confirmedBy: outcome.approvedBy || "unknown", evidenceId: ev.id,
      });
      publish("knowledge", { record: rule, note: "Rule confirmed at the gate and stored — auto-applied next period." });
      run.record("rule_learned", { supplier: line.supplier, account: outcome.account, confirmedBy: outcome.approvedBy || "unknown", evidenceId: ev.id });
      // The line is resolved now — without this the re-check below still
      // counted it as an open low-confidence line.
      line.account = outcome.account;
      line.confidence = 0.98;
      feed("l_archivista", `Rule saved to Cortex: ${line.supplier} -> ${outcome.account} (conf 0.98), confirmed by ${outcome.approvedBy || "unknown"}. Tail shrinks next period.`, "good");
      await wait(400);
    }
  }

  // 4 — Act on each anomaly. A missing document routes through Lo Smistatore
  // to the real L'Amministrativo; a VAT-rule or prior-period anomaly is a
  // correction request instead (Rulebook Section 9.2) — the record is held
  // either way until it clears.
  for (const an of anomalies) {
    const seenBefore = prior.recurring[an.ruleId] || 0;
    run.record("anomaly_flagged", { ruleId: an.ruleId, kind: an.kind, message: describeAnomaly(an), seenInEarlierRuns: seenBefore });
    if (an.kind !== "item_missing") {
      feed("l_addetto_iva", `Anomaly (${an.ruleId}): ${an.message}${seenBefore ? ` — recurring: ${an.ruleId} was also flagged in ${seenBefore} earlier run(s) for this client.` : ""}`, "warn");
      publish("board", { step: "flagged", label: `Problem found — ${describeAnomaly(an)}` });
      const ev = evidence.put({ kind: "anomaly", ruleId: an.ruleId, detail: an, period });
      publish("evidence", { record: ev });
      // The durable Lo Smistatore consumer runs the routing operation, persists
      // its result, and publishes the compatible UI routing/feed events.
      await a2a({ type: "correction_request", from: "l_addetto_iva", to: "lo_smistatore", client: vatBatch.client,
                  ruleId: an.ruleId, message: describeAnomaly(an), period });
      await wait(600);
      continue;
    }

    const instruction = `fetch ${an.expected.replace(/^invoice\s+/, "")} for ${an.period}`;
    const instructionMessage = await a2a({
      type: "instruction_from_studio", from: "lo_smistatore", to: "l_amministrativo", client: vatBatch.client,
      instruction, due: an.period,
    });
    feed("lo_smistatore", `Anomaly routed to the client agent: ${an.expected}.`);
    const instructionOutcome = await waitForA2AOutcome(instructionMessage.id);
    if (instructionOutcome.status !== "completed") {
      throw new Error(`Runtime could not handle the studio instruction: ${instructionOutcome.run?.error?.code || instructionOutcome.status}`);
    }
    const result = instructionOutcome.result;
    run.record("missing_document_handled", { expected: an.expected, period: an.period, askedOwner: !!result.askedOwner, found: !!result.found });

    if (result.askedOwner) {
      feed("l_amministrativo", `Missing invoice not on file — asked the owner on WhatsApp (request ${result.requestId}).`);
      const waStatus = wa.status();
      const liveWhatsApp = waStatus.send.live && waStatus.receive.webhookEnabled;
      let gotDocument = false;

      if (liveWhatsApp) {
        // Real two-way WhatsApp is configured: wait for the owner's actual reply
        // (whatsappInbound.mjs closes the request when it arrives), or for a
        // person to press "Mark received" in the Approvals tab.
        publish("board", { step: "awaiting_owner", label: "Waiting for the owner's reply on WhatsApp" });
        feed("l_amministrativo", `Waiting for the owner's WhatsApp reply (up to ${Math.round(OWNER_REPLY_TIMEOUT_MS / 60000)} min) — or press "Mark received" in Approvals.`);
        const outcome = await waitForDocumentRequest(result.requestId, OWNER_REPLY_TIMEOUT_MS);
        run.record("owner_reply", { requestId: result.requestId, outcome });
        if (outcome === "resolved") {
          // The truth is what TeamSystem now holds, not a made-up line: re-read the
          // batch and take the line(s) the owner's document actually produced.
          const supplier = an.expected.replace(/^invoice\s+/i, "").trim();
          const fresh = await teamSystem.readVatBatch(clientId, period);
          const known = new Set(vatBatch.lines.map((l) => l.id));
          const newLines = fresh.lines.filter((l) => !known.has(l.id) && sameSupplier(l.supplier, supplier));
          if (newLines.length) {
            for (const line of newLines) {
              // A freshly filed invoice arrives unclassified — classify it like any tail line.
              const r = await classifyLine(line, vatBatch.client, chartOfAccounts);
              if (!r.needsHuman) { line.account = r.account; line.confidence = r.confidence; }
              vatBatch.lines.push(line);
              run.record("document_line_added", { line: line.id, supplier: line.supplier, net: line.net, vat: line.vat, account: line.account });
            }
            received.push({ supplier, period: an.period });
            feed("l_addetto_iva", `Invoice from ${supplier} read from the owner's document in TeamSystem: ${newLines.map((l) => `${l.id} (net €${l.net}, VAT €${l.vat}${l.account ? `, account ${l.account}` : ", needs a category"})`).join("; ")} — added to the batch.`, "good");
          } else {
            feed("l_addetto_iva", `The owner's document is filed in TeamSystem, but no ${supplier} invoice line could be read from it — a person needs to enter it in TeamSystem. Item stays open.`, "warn");
          }
        } else {
          feed("l_amministrativo", `No reply from the owner yet — request ${result.requestId} stays open. Continuing with the invoice still missing; re-run Validate once it arrives.`, "warn");
        }
      } else {
        // WhatsApp not configured (offline stub): simulate the owner's reply so the
        // demo still runs end to end. Same two-phase path as a real resolution:
        // persist the outgoing event, then commit the local state/evidence change.
        await wait(1200);
        const sdiId = "IT" + Math.floor(Math.random() * 900 + 100);
        const resolution = La.prepareDocumentRequestResolution(result.requestId, { foundVia: "owner_reply", sdiId });
        if (resolution) {
          await publishA2A(resolution.a2a, { publisher: resolution.a2a.from });
          const resolved = resolution.commit();
          publish("evidence", { record: resolved.evidence });
          await a2a({ from: "lo_smistatore", to: "l_amministrativo", client: vatBatch.client, type: "acknowledgment", ref: sdiId });
        }
        gotDocument = true;
      }

      if (gotDocument) {
        // Offline/simulated path only: no real document exists, so the demo inserts
        // its fixture line. The live path above uses what TeamSystem actually holds.
        feed("l_addetto_iva", "Missing invoice received (simulated) — re-inserted into the batch.", "good");
        vatBatch.lines.push({ id: "L5", supplier: "Verdi Srl", desc: "Fornitura mensile", net: 600.0, vat: 132.0, account: "30.10", confidence: 0.95 });
        received.push({ supplier: "Verdi Srl", period: an.period });
      }
    } else if (result.found) {
      feed("l_addetto_iva", "L'Amministrativo found the invoice on the client's own systems — no need to ask the owner.", "good");
      vatBatch.lines.push({ id: "L5", supplier: "Verdi Srl", desc: "Fornitura mensile", net: 600.0, vat: 132.0, account: "30.10", confidence: 0.95 });
      received.push({ supplier: "Verdi Srl", period: an.period });
    }
    await wait(700);
  }

  // 5 — Re-assemble + prove; re-validate to show it now passes clean.
  const recheck = validateBatch(vatBatch, { receivedDocs: received, priorPeriod, taxonomy: chartOfAccounts, vatGroup: master.vatGroup, formatAnomalies: vatBatch.formatAnomalies });
  const stillOpen = recheck.tail.length + recheck.anomalies.length;
  run.record("rechecked", { tail: recheck.tail.length, anomalies: recheck.anomalies.length, stillOpen });
  publish("board", {
    step: "reassembled",
    label: stillOpen === 0
      ? "Re-checked after the fixes — everything is now correct"
      : `Re-checked after the fixes — ${stillOpen} item${stillOpen === 1 ? "" : "s"} still need${stillOpen === 1 ? "s" : ""} attention`,
  });
  // The preparation step now crosses the real runtime boundary: the engine
  // loads L'Addetto IVA's active manifest, confirms `ade.prepare_only` is an
  // allowed registered tool, applies guardrails, and validates the artifact.
  const preparationRun = await runAgent({
    seat: "l_addetto_iva",
    operation: "prepare_submission",
    input: { batch: vatBatch },
    context: { clientId: vatBatch.client, actor: "system" },
  });
  if (preparationRun.status !== "completed") {
    throw new Error(`Runtime could not prepare the AdE submission: ${preparationRun.error?.code || preparationRun.status}`);
  }
  const prepared = preparationRun.artifacts[0];
  run.record("submission_prepared", { protocolDraft: prepared.protocolDraft });
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

  // write-back to TeamSystem: a real status + a real computed deadline, not
  // a hardcoded string. The mock renders this as a notification in the
  // client's own tab — this is what that notification actually says.
  const deadline = computeVatDeadline(period);
  const summary = stillOpen === 0
    ? `Batch validated and clean for ${period} — ready for the professional's signature.`
    : `Batch prepared for ${period} with ${stillOpen} item${stillOpen === 1 ? "" : "s"} still open — professional review needed before signing.`;
  // The status decides what TeamSystem does next: a clean batch goes to the
  // professional for signature; open items become tasks + client requests.
  const wbStatus = stillOpen === 0 ? "awaiting_signature" : "needs_review";
  const openItems = [
    ...recheck.anomalies.map((a) => ({ type: "anomaly", kind: a.kind, ruleId: a.ruleId, supplier: a.supplier || null, message: describeAnomaly(a), recurringCount: prior.recurring[a.ruleId] || 0 })),
    ...recheck.tail.map((l) => ({ type: "tail", kind: "low_confidence", supplier: l.supplier, message: `Line ${l.id} (${l.supplier}) still needs a confirmed category` })),
  ];
  const wb = await teamSystem.writeBack(vatBatch.client, period, {
    status: wbStatus, summary, deadline, tailCount: recheck.tail.length, anomalyCount: recheck.anomalies.length, openItems,
  });
  run.record("written_back", { status: wbStatus, delivered: wb.deliveredToFirm, stage: wb.workflow?.stage || null, nextSteps: wb.workflow?.nextSteps || [] });
  for (const step of wb.workflow?.nextSteps || []) feed("teamsystem", `TeamSystem next step: ${step}`, "info");
  publish("board", { step: "writeback", label: wb.deliveredToFirm ? `Sent back to TeamSystem — deadline ${deadline}` : "Couldn't reach TeamSystem — filing update saved locally only" });
  feed("teamsystem",
    wb.deliveredToFirm
      ? `Sent back to TeamSystem: ${summary} Deadline: ${deadline}.`
      : `TeamSystem wasn't reachable — this filing update did NOT reach it, saved locally only.`,
    wb.deliveredToFirm ? "good" : "warn");

  const { profile } = clientMemory.finishRun(run, {
    tail: initialTail, anomalies: initialAnomalies, openAfter: stillOpen, status: wbStatus, delivered: wb.deliveredToFirm,
    anomalyRules: anomalies.map((a) => a.ruleId),
  });
  const before = prior.last;
  feed("l_archivista", before
    ? `Cortex memory updated (run #${profile.runs}): low-confidence lines ${before.tail} -> ${initialTail}, problems ${before.anomalies} -> ${initialAnomalies}.`
    : `Cortex memory updated (run #${profile.runs}): this client's baseline is ${initialTail} low-confidence line(s) and ${initialAnomalies} problem(s).`, "good");

  publish("board", { step: "done", label: "Pre-filing validation complete" });
  return { ok: true };
}
