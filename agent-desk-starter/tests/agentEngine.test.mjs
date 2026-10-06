import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createAgentEngine, defaultAgentEngine, runAgent } from "../backend/runtime/agentEngine.mjs";
import { AgentRegistry } from "../backend/runtime/agentRegistry.mjs";
import { ToolRegistry } from "../backend/runtime/toolRegistry.mjs";
import { ApprovalStore } from "../backend/runtime/approvalStore.mjs";
import { makeMessage } from "../contracts/a2aSchema.mjs";
import { transmit } from "../backend/connectors/adePortal.mjs";
import { pendingCorrections, resolveCorrection, resolveDocumentRequest } from "../backend/lAmministrativo.mjs";

function manifest(seat, tools = [], extra = {}) {
  return {
    seat,
    location: "studio_edge",
    model: { edge: "test", fallback: "test" },
    skills: [],
    tools,
    memory: { read: [], write: [] },
    refuses: [],
    ...extra,
  };
}

function request(seat, operation, input = {}, context = {}) {
  return {
    seat,
    operation,
    input,
    context: { clientId: "client_a", actor: "system", ...context },
  };
}

function harness({ seat = "test_agent", operations, tools = [], allowedTools = tools.map((tool) => tool.id), limits, authorizer, messageFactory } = {}) {
  const agentRegistry = new AgentRegistry().register({ seat, operations });
  const toolRegistry = new ToolRegistry();
  for (const tool of tools) toolRegistry.register(tool);
  const published = [];
  const auditRecords = [];
  const approvalStore = new ApprovalStore();
  const engine = createAgentEngine({
    agentRegistry,
    toolRegistry,
    loadManifest: () => manifest(seat, allowedTools),
    ...(authorizer ? { authorizer } : {}),
    approvalStore,
    publishMessage: (message) => { published.push(message); },
    ...(messageFactory ? { messageFactory } : {}),
    audit: { append: async (record) => { auditRecords.push(record); } },
    limits,
  });
  return { engine, published, auditRecords, approvalStore };
}

test("default runtime executes the real l_addetto_iva prepare-only tool", async () => {
  const result = await runAgent(request("l_addetto_iva", "prepare_submission", {
    batch: { period: "2026-Q3", client: "client_a", lines: [{ id: "L1" }] },
  }));

  assert.equal(result.status, "completed");
  assert.equal(result.error, null);
  assert.equal(result.artifacts[0].prepared, true);
  assert.equal(result.artifacts[0].period, "2026-Q3");
});

test("default runtime handles a studio instruction through guarded client tools and typed A2A", async () => {
  const result = await runAgent(request("l_amministrativo", "handle_instruction", {
    message: { instruction: "fetch Runtime Supplier for 2099-Q1", due: "2099-Q1" },
  }, { actor: "agent:lo_smistatore", correlationId: "runtime-instruction-1" }));

  assert.equal(result.status, "completed");
  assert.equal(result.artifacts[0].askedOwner, true);
  assert.ok(result.artifacts[0].requestId);
  assert.deepEqual(result.messages.map((message) => message.type), ["acknowledgment", "item_missing"]);
  assert.ok(result.messages.every((message) => message.correlationId === "runtime-instruction-1"));
  resolveDocumentRequest(result.artifacts[0].requestId, { sdiId: "RUNTIME-CLEANUP" });
});

test("default runtime configuration covers every business tool of its enabled seats", async () => {
  const report = await defaultAgentEngine.validateConfiguration();
  assert.equal(report.ok, true);
  assert.deepEqual(report.reports.map(({ seat, missingTools }) => ({ seat, missingTools })), [
    { seat: "lo_smistatore", missingTools: [] },
    { seat: "l_addetto_iva", missingTools: [] },
    { seat: "l_amministrativo", missingTools: [] },
  ]);
});

test("runtime configuration validation reports missing tools and fails strict startup", async () => {
  const engine = createAgentEngine({
    agentRegistry: new AgentRegistry().register({ seat: "test_agent", operations: { run: async () => ({ artifacts: [] }) } }),
    toolRegistry: new ToolRegistry(),
    loadManifest: () => manifest("test_agent", ["missing.tool", "a2a.endpoint:receiver"]),
    audit: { append: async () => {} },
    publishMessage: () => {},
  });

  const report = await engine.validateConfiguration({ strict: false });
  assert.equal(report.ok, false);
  assert.deepEqual(report.reports[0].missingTools, ["missing.tool"]);
  await assert.rejects(engine.validateConfiguration(), (error) => error.code === "RUNTIME_CONFIGURATION_INVALID");
});

test("unknown agents and operations fail closed with stable codes", async () => {
  const { engine } = harness({ operations: { known: async () => ({ artifacts: [] }) } });

  const unknownAgentEngine = createAgentEngine({
    agentRegistry: new AgentRegistry().register({ seat: "registered", operations: { known: async () => ({ artifacts: [] }) } }),
    toolRegistry: new ToolRegistry(),
    loadManifest: (seat) => manifest(seat),
    audit: { append: async () => {} },
    publishMessage: () => {},
  });
  const unknownAgent = await unknownAgentEngine.runAgent(request("not_registered", "known"));
  const unknownOperation = await engine.runAgent(request("test_agent", "missing"));

  assert.equal(unknownAgent.status, "failed");
  assert.equal(unknownAgent.error.code, "UNKNOWN_AGENT");
  assert.equal(unknownOperation.error.code, "UNKNOWN_OPERATION");
});

test("malformed requests and operation inputs still return valid structured failures", async () => {
  const { engine } = harness({
    operations: {
      run: {
        inputSchema: z.object({ required: z.string() }).strict(),
        handler: async () => ({ artifacts: [] }),
      },
    },
  });

  const malformed = await engine.runAgent({
    runId: "x".repeat(500),
    seat: "test_agent",
    operation: "run",
    context: {},
  });
  const invalidInput = await engine.runAgent(request("test_agent", "run", {}));

  assert.equal(malformed.status, "failed");
  assert.equal(malformed.error.code, "INVALID_RUNTIME_REQUEST");
  assert.ok(malformed.runId.length <= 160);
  assert.equal(invalidInput.error.code, "INVALID_AGENT_INPUT");
});

test("unregistered and non-allowlisted tools never execute", async () => {
  let called = 0;
  const definition = {
    id: "demo.read",
    action: "read_demo",
    risk: "read",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ ok: z.boolean() }).strict(),
    execute: async () => { called += 1; return { ok: true }; },
  };
  const unregistered = harness({
    operations: { run: async (_, ctx) => { await ctx.tools.invoke("missing.tool"); return { artifacts: [] }; } },
  });
  const forbidden = harness({
    operations: { run: async (_, ctx) => { await ctx.tools.invoke("demo.read"); return { artifacts: [] }; } },
    tools: [definition],
    allowedTools: [],
  });

  const missingResult = await unregistered.engine.runAgent(request("test_agent", "run"));
  const forbiddenResult = await forbidden.engine.runAgent(request("test_agent", "run"));

  assert.equal(missingResult.error.code, "UNKNOWN_TOOL");
  assert.equal(forbiddenResult.status, "refused");
  assert.equal(forbiddenResult.error.code, "TOOL_NOT_ALLOWED");
  assert.equal(called, 0);
});

test("runtime identity overrides spoofed input and messages keep correlation", async () => {
  const { engine, published } = harness({
    operations: {
      run: async (input, ctx) => {
        ctx.messages.emit("acknowledgment", { ref: input.ref }, { to: "receiver" });
        return { artifacts: [{ identity: ctx.identity }] };
      },
    },
    allowedTools: ["a2a.endpoint:receiver"],
  });

  const result = await engine.runAgent(request("test_agent", "run", {
    ref: "ref-1",
    seat: "spoofed",
    clientId: "client_b",
  }, { correlationId: "corr-123" }));

  assert.equal(result.status, "completed");
  assert.equal(result.artifacts[0].identity.seat, "test_agent");
  assert.equal(result.artifacts[0].identity.clientId, "client_a");
  assert.equal(result.messages[0].from, "test_agent");
  assert.equal(result.messages[0].client, "client_a");
  assert.equal(result.messages[0].correlationId, "corr-123");
  assert.equal(published.length, 1);
});

test("outbound signing is an injectable boundary and occurs before publication", async () => {
  let signingCalls = 0;
  const { engine, published } = harness({
    operations: {
      run: async (_, ctx) => {
        ctx.messages.emit("acknowledgment", { ref: "signed-ref" }, { to: "receiver" });
        return { artifacts: [] };
      },
    },
    allowedTools: ["a2a.endpoint:receiver"],
    messageFactory: (input) => {
      signingCalls += 1;
      return { ...makeMessage(input), sig: "injected-test-signature" };
    },
  });

  const result = await engine.runAgent(request("test_agent", "run"));
  assert.equal(result.status, "completed");
  assert.equal(signingCalls, 1);
  assert.equal(published[0].sig, "injected-test-signature");
});

test("an operation cannot invoke a tool outside its declared capability set", async () => {
  let called = false;
  const { engine } = harness({
    operations: {
      run: {
        tools: [],
        handler: async (_, ctx) => { await ctx.tools.invoke("demo.read", {}); return { artifacts: [] }; },
      },
    },
    tools: [{ id: "demo.read", action: "read_demo", risk: "read", execute: async () => { called = true; return {}; } }],
  });

  const result = await engine.runAgent(request("test_agent", "run"));
  assert.equal(result.status, "refused");
  assert.equal(result.error.code, "OPERATION_TOOL_NOT_DECLARED");
  assert.equal(called, false);
});

test("tool-call and outbound-message limits are enforced", async () => {
  const tool = {
    id: "demo.read", action: "read_demo", risk: "read", idempotent: true,
    inputSchema: z.object({}).strict(), outputSchema: z.object({ ok: z.literal(true) }).strict(),
    execute: async () => ({ ok: true }),
  };
  const toolLimited = harness({
    operations: { run: async (_, ctx) => { await ctx.tools.invoke("demo.read"); await ctx.tools.invoke("demo.read"); return { artifacts: [] }; } },
    tools: [tool], limits: { maxToolCalls: 1 },
  });
  const messageLimited = harness({
    operations: { run: async (_, ctx) => {
      ctx.messages.emit("acknowledgment", { ref: "one" }, { to: "receiver" });
      ctx.messages.emit("acknowledgment", { ref: "two" }, { to: "receiver" });
      return { artifacts: [] };
    } },
    allowedTools: ["a2a.endpoint:receiver"], limits: { maxMessages: 1 },
  });

  const toolResult = await toolLimited.engine.runAgent(request("test_agent", "run"));
  const messageResult = await messageLimited.engine.runAgent(request("test_agent", "run"));
  assert.equal(toolResult.error.code, "TOOL_CALL_LIMIT");
  assert.equal(messageResult.error.code, "MESSAGE_LIMIT");
});

test("approval-required is a first-class outcome and the tool does not execute", async () => {
  let called = false;
  const tool = {
    id: "demo.write", action: "write_demo", risk: "write", requiresApproval: true,
    inputSchema: z.object({ value: z.string() }).strict(), outputSchema: z.object({ ok: z.boolean() }).strict(),
    execute: async () => { called = true; return { ok: true }; },
  };
  const { engine } = harness({
    operations: { run: async (_, ctx) => { await ctx.tools.invoke("demo.write", { value: "x" }); return { artifacts: [] }; } },
    tools: [tool],
  });

  const result = await engine.runAgent(request("test_agent", "run"));
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.error.code, "APPROVAL_REQUIRED");
  assert.equal(result.approval.toolId, "demo.write");
  assert.equal(called, false);
});

test("rerunning the exact approved run consumes its receipt immediately before execution", async () => {
  let calls = 0;
  const gatedTool = {
    id: "demo.write", action: "write_demo", risk: "write", requiresApproval: true,
    inputSchema: z.object({ value: z.string() }).strict(), outputSchema: z.object({ ok: z.boolean() }).strict(),
    execute: async () => { calls += 1; return { ok: true }; },
  };
  const { engine, approvalStore } = harness({
    operations: { run: async (input, ctx) => { await ctx.tools.invoke("demo.write", input); return { artifacts: [] }; } },
    tools: [gatedTool],
  });
  const exactRequest = { ...request("test_agent", "run", { value: "approved" }), runId: "stable-run-id" };

  const pending = await engine.runAgent(exactRequest);
  await approvalStore.approve(pending.approval.id, { approvedBy: "maria", approverRole: "studio_professional" });
  const completed = await engine.runAgent(exactRequest);

  assert.equal(pending.status, "awaiting_approval");
  assert.equal(completed.status, "completed");
  assert.equal(calls, 1);
  assert.equal((await approvalStore.get(pending.approval.id)).status, "consumed");
});

test("system refusal blocks authority transmission before the connector", async () => {
  let called = false;
  const agentRegistry = new AgentRegistry().register({
    seat: "l_addetto_iva",
    operations: { run: async (_, ctx) => { await ctx.tools.invoke("ade.transmit"); return { artifacts: [] }; } },
  });
  const toolRegistry = new ToolRegistry().register({
    id: "ade.transmit", action: "transmit_to_authority", risk: "authority",
    execute: async () => { called = true; return {}; },
  });
  const engine = createAgentEngine({
    agentRegistry, toolRegistry,
    loadManifest: () => manifest("l_addetto_iva", ["ade.transmit"]),
    audit: { append: async () => {} }, publishMessage: () => {},
  });

  const result = await engine.runAgent(request("l_addetto_iva", "run"));
  assert.equal(result.status, "refused");
  assert.equal(result.error.code, "SYSTEM_REFUSAL");
  assert.equal(called, false);
  await assert.rejects(() => transmit(), /REFUSED/);
});

test("invalid artifacts, outbound messages, and handler exceptions become structured failures", async () => {
  const artifactHarness = harness({ operations: { run: async () => ({ artifacts: [1n] }) } });
  const messageHarness = harness({
    operations: { run: async (_, ctx) => { ctx.messages.emit("acknowledgment", {}, { to: "receiver" }); return { artifacts: [] }; } },
    allowedTools: ["a2a.endpoint:receiver"],
  });
  const exceptionHarness = harness({ operations: { run: async () => { throw new Error("secret internal failure"); } } });

  const artifact = await artifactHarness.engine.runAgent(request("test_agent", "run"));
  const message = await messageHarness.engine.runAgent(request("test_agent", "run"));
  const exception = await exceptionHarness.engine.runAgent(request("test_agent", "run"));

  assert.equal(artifact.error.code, "ARTIFACT_TOO_LARGE");
  assert.equal(message.error.code, "INVALID_OUTBOUND_MESSAGE");
  assert.equal(exception.error.code, "UNEXPECTED_RUNTIME_ERROR");
  assert.equal(exception.error.message.includes("secret"), false);
});

test("message publication failure is explicit and does not report delivery", async () => {
  const agentRegistry = new AgentRegistry().register({
    seat: "test_agent",
    operations: {
      run: async (_, ctx) => {
        ctx.messages.emit("acknowledgment", { ref: "ref" }, { to: "receiver" });
        return { artifacts: [] };
      },
    },
  });
  const engine = createAgentEngine({
    agentRegistry,
    toolRegistry: new ToolRegistry(),
    loadManifest: () => manifest("test_agent", ["a2a.endpoint:receiver"]),
    audit: { append: async () => {} },
    publishMessage: () => { throw new Error("broker unavailable"); },
  });

  const result = await engine.runAgent(request("test_agent", "run"));
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "MESSAGE_PUBLISH_FAILED");
  assert.equal(result.error.retryable, true);
  assert.deepEqual(result.messages, []);
});

test("timeout and external cancellation close the context before later tool calls", async () => {
  let calls = 0;
  const tool = { id: "demo.read", action: "read_demo", risk: "read", execute: async () => { calls += 1; return {}; } };
  const makeSlow = (limits) => harness({
    operations: { run: async (_, ctx) => { await new Promise((resolve) => setTimeout(resolve, 40)); await ctx.tools.invoke("demo.read"); return { artifacts: [] }; } },
    tools: [tool], limits,
  }).engine;

  const timedOut = await makeSlow({ maxRunMs: 5 }).runAgent(request("test_agent", "run"));
  const controller = new AbortController();
  const cancellation = makeSlow({ maxRunMs: 1_000 }).runAgent(request("test_agent", "run"), { signal: controller.signal });
  controller.abort();
  const cancelled = await cancellation;
  await new Promise((resolve) => setTimeout(resolve, 55));

  assert.equal(timedOut.error.code, "RUN_TIMEOUT");
  assert.equal(cancelled.error.code, "RUN_CANCELLED");
  assert.equal(calls, 0);
});

test("concurrent runs keep client and correlation contexts isolated", async () => {
  const { engine } = harness({
    operations: { run: async (input, ctx) => {
      await new Promise((resolve) => setTimeout(resolve, input.delay));
      return { artifacts: [{ ...ctx.identity }] };
    } },
  });

  const [a, b] = await Promise.all([
    engine.runAgent(request("test_agent", "run", { delay: 15 }, { clientId: "client_a", correlationId: "corr-a" })),
    engine.runAgent(request("test_agent", "run", { delay: 1 }, { clientId: "client_b", correlationId: "corr-b" })),
  ]);

  assert.equal(a.artifacts[0].clientId, "client_a");
  assert.equal(a.artifacts[0].correlationId, "corr-a");
  assert.equal(b.artifacts[0].clientId, "client_b");
  assert.equal(b.artifacts[0].correlationId, "corr-b");
});

test("default runtime relays a correction_request to the owner, tracks it, and closes it with answer_with_evidence", async () => {
  const result = await runAgent(request("l_amministrativo", "handle_correction", {
    message: { ruleId: "VAT-7", message: "P.IVA of supplier Rossi looks invalid", period: "2099-Q2" },
  }, { actor: "agent:lo_smistatore", correlationId: "runtime-correction-1" }));

  assert.equal(result.status, "completed");
  assert.equal(result.artifacts[0].askedOwner, true);
  assert.ok(result.artifacts[0].correctionId);
  assert.deepEqual(result.messages.map((message) => message.type), ["acknowledgment"]);
  assert.ok(pendingCorrections.has(result.artifacts[0].correctionId));

  const resolution = resolveCorrection(result.artifacts[0].correctionId, { answer: "Corrected P.IVA is 01234567890", confirmedBy: "owner" });
  assert.ok(resolution);
  assert.equal(resolution.a2a.type, "answer_with_evidence");
  assert.equal(resolution.a2a.ref, result.artifacts[0].correctionId);
  assert.equal(resolution.evidence.kind, "correction_answer");
  assert.equal(pendingCorrections.has(result.artifacts[0].correctionId), false);
  // Closing twice is a no-op, not a second message to the studio.
  assert.equal(resolveCorrection(result.artifacts[0].correctionId, {}), null);
});

test("correction_request input rejects extra fields (no free-text smuggling)", async () => {
  const result = await runAgent(request("l_amministrativo", "handle_correction", {
    message: { ruleId: "VAT-7", message: "x", period: "2099-Q2", extra: "nope" },
  }));
  assert.notEqual(result.status, "completed");
});
