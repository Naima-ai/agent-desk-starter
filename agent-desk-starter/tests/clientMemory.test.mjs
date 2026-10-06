import test from "node:test";
import assert from "node:assert/strict";
import { beginRun, finishRun, priorContext, getClientMemory } from "../backend/memory/clientMemory.mjs";

const CLIENT = `mem_test_${Date.now()}`;

test("a client with no history has an empty prior context", () => {
  const p = priorContext(CLIENT);
  assert.equal(p.runs, 0);
  assert.equal(p.last, null);
});

test("every action is stored as evidence and the profile learns across runs", () => {
  const run1 = beginRun(CLIENT);
  run1.period = "2026-Q3";
  run1.record("validated", { tail: 3, anomalies: 2 });
  run1.record("anomaly_flagged", { ruleId: "CST-04" });
  finishRun(run1, { tail: 3, anomalies: 2, openAfter: 1, status: "needs_review", anomalyRules: ["CST-04", "FMT-03"] });

  const run2 = beginRun(CLIENT);
  assert.equal(run2.prior.runs, 1, "the second run reads the first run's profile before starting");
  assert.equal(run2.prior.last.tail, 3);
  assert.equal(run2.prior.recurring["CST-04"], 1);
  run2.period = "2026-Q3";
  finishRun(run2, { tail: 1, anomalies: 2, openAfter: 0, status: "awaiting_signature", anomalyRules: ["CST-04"] });

  const mem = getClientMemory(CLIENT);
  assert.equal(mem.runs, 2);
  assert.equal(mem.recurring["CST-04"], 2);
  assert.equal(mem.recurring["FMT-03"], 1);
  assert.deepEqual(mem.trend.map((t) => t.tail), [3, 1]);
  assert.equal(mem.recentRuns.length, 2);
});

test("memory is partitioned per client", () => {
  assert.equal(getClientMemory("someone_else").runs, 0);
});
