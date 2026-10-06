// backend/memory/clientMemory.mjs — Loop Cortex Memory, per client.
// Every action taken while validating a client is written to the EVIDENCE
// store (append-only: "what was done, and when"), and each finished run
// updates a per-client PROFILE in the KNOWLEDGE store ("what we now believe
// about this client": run count, tail/anomaly trend, recurring problems).
// The next run reads that profile first, so the desk gets better per client:
// it knows it has seen this client before, whether the tail is shrinking,
// and which problems keep coming back.
// >>> TODO (real): same swap as the two stores underneath — LanceDB /
//     memory-wiki, partitioned per client. This module's API stays the same.
import * as evidence from "./evidenceStore.mjs";
import * as knowledge from "./knowledgeStore.mjs";

const HISTORY_CAP = 20;
const profileKey = (clientId) => `client:${clientId}:profile`;

const emptyProfile = () => ({ runs: 0, lastPeriod: null, lastRunAt: null, history: [], recurring: {} });

function readProfile(clientId) {
  return knowledge.get(profileKey(clientId))?.value || emptyProfile();
}

/** What the desk already knows about this client, read BEFORE a run starts. */
export function priorContext(clientId) {
  const p = readProfile(clientId);
  const last = [...p.history].reverse().find((h) => h.status !== "failed") || null; // a crashed run has no tail/anomaly counts to learn from
  const rules = knowledge.all().filter((r) => r.scope === `client:${clientId}` && r.kind === "coa_mapping" && r.status === "confirmed");
  return { runs: p.runs, last, recurring: { ...p.recurring }, rulesLearned: rules.length };
}

/** Start recording a run. `run.record(action, detail)` appends one immutable
 *  evidence entry per action; `finishRun` closes it and updates the profile. */
export function beginRun(clientId) {
  const prior = priorContext(clientId);
  const run = {
    id: `run_${clientId}_${Date.now().toString(36)}`,
    clientId, period: null, startedAt: new Date().toISOString(), seq: 0, prior,
    record(action, detail = {}) {
      run.seq += 1;
      return evidence.put({ kind: "validation_action", client: clientId, runId: run.id, seq: run.seq, action, period: run.period, detail });
    },
  };
  return run;
}

/** Close a run: one summary evidence record + an updated knowledge profile.
 *  outcome: { tail, anomalies, openAfter, status, delivered, failed?, error?, anomalyRules[] } */
export function finishRun(run, outcome) {
  const summary = evidence.put({
    kind: "validation_run", client: run.clientId, runId: run.id, period: run.period,
    startedAt: run.startedAt, finishedAt: new Date().toISOString(), actions: run.seq, outcome,
  });
  const p = readProfile(run.clientId);
  const recurring = { ...p.recurring };
  for (const ruleId of outcome.anomalyRules || []) recurring[ruleId] = (recurring[ruleId] || 0) + 1;
  const entry = {
    runId: run.id, period: run.period, at: summary.at,
    tail: outcome.tail ?? null, anomalies: outcome.anomalies ?? null, openAfter: outcome.openAfter ?? null,
    status: outcome.failed ? "failed" : (outcome.status || null),
  };
  const next = {
    runs: p.runs + 1, lastPeriod: run.period || p.lastPeriod, lastRunAt: summary.at,
    history: [...p.history, entry].slice(-HISTORY_CAP), recurring,
  };
  knowledge.upsert({
    key: profileKey(run.clientId), kind: "client_profile", scope: `client:${run.clientId}`,
    value: next, confidence: 1, source: "validation_runs", confirmedBy: "system", evidenceId: summary.id, status: "confirmed",
  });
  return { summary, profile: next };
}

/** Everything the desk remembers about one client, for the UI. */
export function getClientMemory(clientId) {
  const profile = readProfile(clientId);
  const all = evidence.all().filter((e) => e.client === clientId);
  const runs = all.filter((e) => e.kind === "validation_run").slice(-10).reverse();
  const lastRun = runs[0] || null;
  const lastActions = lastRun ? all.filter((e) => e.kind === "validation_action" && e.runId === lastRun.runId).sort((a, b) => a.seq - b.seq) : [];
  const rules = knowledge.all()
    .filter((r) => r.scope === `client:${clientId}` && r.kind === "coa_mapping")
    .map((r) => ({ key: r.key, supplier: r.key.split(":coa:")[1] || r.key, account: r.value, status: r.status, confidence: r.confidence, confirmedBy: r.confirmedBy, version: r.version, lastVerified: r.lastVerified }));
  const trend = profile.history.map((h) => ({ period: h.period, at: h.at, tail: h.tail, anomalies: h.anomalies, openAfter: h.openAfter, status: h.status }));
  return { clientId, runs: profile.runs, recurring: profile.recurring, trend, rules, recentRuns: runs, lastRunActions: lastActions };
}
