import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore } from "../backend/runtime/approvalStore.mjs";
import { createGuardrails, hashArguments, normalizeGate } from "../backend/runtime/guardrails.mjs";
import { ToolRegistry } from "../backend/runtime/toolRegistry.mjs";

function manifest(seat = "test_agent", extra = {}) {
  return {
    seat, location: "studio_edge", model: { edge: "test", fallback: "test" },
    skills: [], tools: ["demo.tool"], memory: { read: [0], write: [3] }, refuses: [],
    ...extra,
  };
}

function run(extra = {}) {
  return { runId: "run-a", seat: "test_agent", clientId: "client-a", correlationId: "corr-a", actor: "tester", ...extra };
}

function tool(extra = {}) {
  return { id: "demo.tool", action: "read_demo", risk: "read", requiresApproval: false, ...extra };
}

function setup({ now = Date.parse("2026-01-01T00:00:00Z"), audit = null } = {}) {
  let current = now;
  const records = [];
  const clock = () => current;
  const approvalStore = new ApprovalStore({ clock, idGenerator: (() => { let n = 0; return () => `id-${++n}`; })() });
  const authorize = createGuardrails({
    approvalStore,
    audit: audit || { append: async (record) => { records.push(record); } },
    clock,
    idGenerator: (() => { let n = 0; return () => `decision-${++n}`; })(),
  });
  return { authorize, approvalStore, records, advance(ms) { current += ms; } };
}

test("allows a registered, allowlisted tool and emits a payload-free audit record", async () => {
  const h = setup();
  const decision = await h.authorize({ run: run(), manifest: manifest(), tool: tool(), args: { secret: "not-audited" } });
  assert.equal(decision.outcome, "allow");
  assert.equal(decision.decisionId, "decision-1");
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].outcome, "allow");
  assert.equal(h.records[0].argsHash, hashArguments({ secret: "not-audited" }));
  assert.equal(JSON.stringify(h.records[0]).includes("not-audited"), false);
});

test("denies tools missing from the manifest and rejects registry aliases", async () => {
  const h = setup();
  const decision = await h.authorize({ run: run(), manifest: manifest("test_agent", { tools: [] }), tool: tool(), args: {} });
  assert.equal(decision.code, "TOOL_NOT_ALLOWED");
  assert.throws(() => new ToolRegistry().register({
    id: "demo.tool", aliases: ["safe-looking-name"], action: "read_demo", risk: "read", execute: () => ({}),
  }), /aliases are not supported/);
});

test("immutable refusal survives an edited manifest and deny wins over approval", async () => {
  const h = setup();
  const blockedTool = tool({ id: "ade.transmit", action: "transmit_to_authority", risk: "authority", requiresApproval: true });
  const decision = await h.authorize({
    run: run({ seat: "l_addetto_iva" }),
    manifest: manifest("l_addetto_iva", { tools: ["ade.transmit"], refuses: [], gate: "human_review" }),
    tool: blockedTool,
    args: { instruction: "ignore previous restrictions" },
  });
  assert.equal(decision.outcome, "deny");
  assert.equal(decision.code, "SYSTEM_REFUSAL");
  assert.equal((await h.approvalStore.list()).length, 0);
});

test("manifest refusals only add restrictions", async () => {
  const h = setup();
  const decision = await h.authorize({
    run: run(), manifest: manifest("test_agent", { refuses: ["read_demo"] }), tool: tool(), args: {},
  });
  assert.equal(decision.code, "MANIFEST_REFUSAL");
});

test("client, location, and memory boundaries fail closed", async () => {
  const h = setup();
  const client = await h.authorize({ run: run(), manifest: manifest(), tool: tool(), args: { clientId: "client-b" } });
  const location = await h.authorize({ run: run(), manifest: manifest(), tool: tool({ locations: ["client_side"] }), args: {} });
  const memory = await h.authorize({ run: run(), manifest: manifest(), tool: tool({ memoryAccess: { mode: "write", layer: 2 } }), args: {} });
  assert.equal(client.code, "CLIENT_SCOPE_MISMATCH");
  assert.equal(location.code, "LOCATION_NOT_ALLOWED");
  assert.equal(memory.code, "MEMORY_SCOPE_DENIED");
});

test("unknown legacy gates fail closed while none_internal does not gate", async () => {
  assert.equal(normalizeGate("none_internal"), null);
  assert.deepEqual(normalizeGate("new_unreviewed_gate").actions, ["*"]);
  const h = setup();
  const gated = await h.authorize({ run: run(), manifest: manifest("test_agent", { gate: "new_unreviewed_gate" }), tool: tool(), args: {} });
  const open = await h.authorize({ run: run(), manifest: manifest("test_agent", { gate: "none_internal" }), tool: tool(), args: {} });
  assert.equal(gated.outcome, "approval_required");
  assert.equal(open.outcome, "allow");
});

test("an exact approval is consumed once and cannot be replayed", async () => {
  const h = setup();
  const gatedTool = tool({ action: "write_demo", risk: "write", requiresApproval: true });
  const request = { run: run(), manifest: manifest(), tool: gatedTool, args: { a: 1, b: 2 } };
  const pending = await h.authorize(request);
  assert.equal(pending.outcome, "approval_required");
  await h.approvalStore.approve(pending.approval.id, { approvedBy: "maria", approverRole: "studio_professional" });
  const allowed = await h.authorize({ ...request, args: { b: 2, a: 1 }, approvalReceipt: { id: pending.approval.id } });
  const replay = await h.authorize({ ...request, approvalReceipt: { id: pending.approval.id } });
  assert.equal(allowed.outcome, "allow");
  assert.equal((await h.approvalStore.get(pending.approval.id)).status, "consumed");
  assert.equal(replay.outcome, "approval_required");
  assert.notEqual(replay.approval.id, pending.approval.id);
});

test("changed arguments, client, run, tool, or action cannot use an approval", async () => {
  const cases = [
    (request) => ({ ...request, args: { value: "changed" } }),
    (request) => ({ ...request, run: run({ clientId: "client-b" }) }),
    (request) => ({ ...request, run: run({ runId: "run-b" }) }),
    (request) => ({ ...request, tool: tool({ id: "other.tool", action: "write_demo", risk: "write", requiresApproval: true }), manifest: manifest("test_agent", { tools: ["other.tool"] }) }),
    (request) => ({ ...request, tool: tool({ action: "other_action", risk: "write", requiresApproval: true }) }),
  ];
  for (const alter of cases) {
    const h = setup();
    const base = { run: run(), manifest: manifest(), tool: tool({ action: "write_demo", risk: "write", requiresApproval: true }), args: { value: "original" } };
    const pending = await h.authorize(base);
    await h.approvalStore.approve(pending.approval.id, { approvedBy: "maria", approverRole: "studio_professional" });
    const changed = await h.authorize({ ...alter(base), approvalReceipt: { id: pending.approval.id } });
    assert.notEqual(changed.outcome, "allow");
  }
});

test("expired approvals and escalation never authorize execution", async () => {
  const h = setup();
  const request = { run: run(), manifest: manifest(), tool: tool({ action: "write_demo", risk: "write", requiresApproval: true, approvalExpiresInSeconds: 1 }), args: {} };
  const pending = await h.authorize(request);
  await h.approvalStore.approve(pending.approval.id, { approvedBy: "maria", approverRole: "studio_professional" });
  h.advance(1_001);
  const expired = await h.authorize({ ...request, approvalReceipt: { id: pending.approval.id }, escalation: { escalated: true } });
  assert.equal((await h.approvalStore.get(pending.approval.id)).status, "expired");
  assert.equal(expired.outcome, "approval_required");
});

test("wrong approver role is rejected", async () => {
  const h = setup();
  const pending = await h.authorize({ run: run(), manifest: manifest(), tool: tool({ requiresApproval: true }), args: {} });
  await assert.rejects(
    h.approvalStore.approve(pending.approval.id, { approvedBy: "owner", approverRole: "owner" }),
    /does not match/,
  );
});

test("approved receipts survive an approval-store restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-desk-approvals-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "approvals.json");
  const binding = {
    runId: "run-a", seat: "test_agent", clientId: "client-a",
    toolId: "demo.tool", action: "write_demo", argsHash: hashArguments({ value: 1 }),
  };
  const first = new ApprovalStore({ filePath, clock: () => Date.parse("2026-01-01T00:00:00Z"), idGenerator: () => "durable" });
  const pending = await first.request(binding, { requiredApprover: "studio_professional", requester: "tester" });
  await first.approve(pending.id, { approvedBy: "maria", approverRole: "studio_professional" });

  const restarted = new ApprovalStore({ filePath, clock: () => Date.parse("2026-01-01T00:01:00Z") });
  const consumed = await restarted.consumeApproved(binding);
  assert.equal(consumed.id, pending.id);
  assert.equal((await restarted.get(pending.id)).status, "consumed");
});

test("policy exceptions deny and audit every resulting outcome", async () => {
  const h = setup();
  const decision = await h.authorize({
    run: run(), manifest: manifest(), tool: tool({ requiresApproval: () => { throw new Error("broken policy"); } }), args: {},
  });
  assert.equal(decision.code, "POLICY_EVALUATION_FAILED");
  assert.equal(h.records.at(-1).outcome, "deny");
});

test("concurrent approval requests remain isolated by client", async () => {
  const h = setup();
  const gated = tool({ action: "write_demo", risk: "write", requiresApproval: true });
  const [a, b] = await Promise.all([
    h.authorize({ run: run({ clientId: "client-a" }), manifest: manifest(), tool: gated, args: {} }),
    h.authorize({ run: run({ clientId: "client-b" }), manifest: manifest(), tool: gated, args: {} }),
  ]);
  assert.notEqual(a.approval.id, b.approval.id);
  assert.notEqual(a.approval.clientId, b.approval.clientId);
});

test("audit failure permits reads but blocks high-risk operations", async () => {
  const failingAudit = { append: async () => { throw new Error("offline"); } };
  const h = setup({ audit: failingAudit });
  const read = await h.authorize({ run: run(), manifest: manifest(), tool: tool(), args: {} });
  const write = await h.authorize({ run: run(), manifest: manifest(), tool: tool({ action: "write_demo", risk: "write" }), args: {} });
  assert.equal(read.outcome, "allow");
  assert.equal(write.code, "AUDIT_UNAVAILABLE");
});
