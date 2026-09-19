// backend/connectors/teamSystem.mjs
// TeamSystem connector — MOCK ENVIRONMENT.
// TeamSystem's ledger/gestionale has no public API wired into this project yet,
// so this connector simulates it: it hands over the periodic VAT batch
// "compiled from the ledger" and accepts the filing status write-back at the
// end of the flow. Every call returns a fresh copy, so re-running the demo
// doesn't accumulate mutations onto shared fixture data.
// >>> TODO (real): replace the bodies with TeamSystem's actual ledger API once
//     it's available — keep these three function signatures so nothing
//     downstream (validator.mjs, vatFilingPath.mjs) has to change.
import { vatBatch, priorPeriodBatch, period, client } from "../seed.mjs";

const writeBackLog = []; // in-memory ledger of what's been written back this session

/** TeamSystem hands over the batch it compiled from the ledger for this period. */
export async function readVatBatch(periodId = period, clientId = client.id) {
  return {
    ...vatBatch,
    period: periodId,
    client: clientId,
    lines: vatBatch.lines.map((l) => ({ ...l })),
    expected: (vatBatch.expected || []).map((e) => ({ ...e })),
  };
}

/** The same client's prior period, for the validator's prior-period comparison. */
export async function readPriorPeriod(periodId = period, clientId = client.id) {
  return { ...priorPeriodBatch, client: clientId, lines: priorPeriodBatch.lines.map((l) => ({ ...l })) };
}

/** Write the filing status and the closed deadline back into the ledger. */
export async function writeBack(periodId, clientId, status) {
  const rec = { period: periodId, client: clientId, status, at: new Date().toISOString() };
  writeBackLog.push(rec);
  return { ok: true, ...rec };
}

/** For tests/inspection: everything written back this session. */
export function history() { return writeBackLog.slice(); }
