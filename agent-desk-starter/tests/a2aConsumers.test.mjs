import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMessage } from "../contracts/a2aSchema.mjs";
import { publish } from "../backend/bus.mjs";
import { A2ABus } from "../backend/messaging/a2aBus.mjs";
import { MemoryIdempotencyStore } from "../backend/messaging/idempotencyStore.mjs";
import { InMemoryTransport } from "../backend/messaging/inMemoryTransport.mjs";
import { UiBus } from "../backend/messaging/uiBus.mjs";
import { RuntimeA2AConsumers } from "../backend/runtime/a2aConsumers.mjs";
import { createAgentEngine } from "../backend/runtime/agentEngine.mjs";
import { ApprovalStore } from "../backend/runtime/approvalStore.mjs";
import { MemoryAuditLog } from "../backend/runtime/auditLog.mjs";
import { defaultAgentRegistry, defaultToolRegistry } from "../backend/runtime/defaultRegistry.mjs";
import { getActiveManifest } from "../backend/compiler.mjs";
import { resolveDocumentRequest } from "../backend/lAmministrativo.mjs";
import { waitFor } from "./helpers/transportContract.mjs";

function harness(runAgent) {
  const transport = new InMemoryTransport();
  const uiBus = new UiBus();
  const bus = new A2ABus({ transport, uiBus, idempotencyStore: new MemoryIdempotencyStore() });
  const consumers = new RuntimeA2AConsumers({ bus, uiBus, engine: { runAgent } });
  return { bus, transport, uiBus, consumers };
}

test("instruction_from_studio crosses the durable bus and runtime exactly once", async (t) => {
  const calls = [];
  const h = harness(async (request) => {
    calls.push(request);
    return {
      status: "completed",
      artifacts: [{ askedOwner: true, requestId: "docreq-test" }],
      messages: [], error: null,
    };
  });
  t.after(async () => { await h.consumers.close(); await h.bus.close(); });
  await h.consumers.start();
  const message = makeMessage({
    from: "lo_smistatore", to: "l_amministrativo", client: "client-a",
    type: "instruction_from_studio", instruction: "fetch Verdi for 2026-Q3",
    correlationId: "workflow-1",
  });

  await h.bus.publishA2A(message);
  const outcome = await h.consumers.waitForOutcome(message.id);
  assert.equal(outcome.result.requestId, "docreq-test");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, "handle_instruction");
  assert.equal(calls[0].context.correlationId, "workflow-1");
  assert.equal(calls[0].context.causationId, message.id);

  // Simulate broker redelivery after a crash: completion idempotency must ack
  // the duplicate without running the business operation again.
  await h.transport.publish(message.to, JSON.stringify(message), { messageId: message.id });
  await waitFor(async () => {
    const health = await h.transport.health();
    return health.queued === 0 && health.pending === 0;
  });
  assert.equal(calls.length, 1);
});

test("vertical flow executes guarded tools and publishes correlated result messages", async (t) => {
  const transport = new InMemoryTransport();
  const uiBus = new UiBus();
  const bus = new A2ABus({ transport, uiBus, idempotencyStore: new MemoryIdempotencyStore() });
  const audit = new MemoryAuditLog();
  const engine = createAgentEngine({
    agentRegistry: defaultAgentRegistry,
    toolRegistry: defaultToolRegistry,
    loadManifest: getActiveManifest,
    approvalStore: new ApprovalStore(),
    audit,
    publishMessage: (outbound) => bus.publishA2A(outbound, { publisher: outbound.from }),
  });
  const consumers = new RuntimeA2AConsumers({ bus, engine, uiBus });
  t.after(async () => { await consumers.close(); await bus.close(); });
  await consumers.start();
  const incoming = makeMessage({
    from: "lo_smistatore", to: "l_amministrativo", client: "integration-client",
    type: "instruction_from_studio", instruction: "fetch Verdi Srl for 2026-Q3",
    correlationId: "integration-workflow",
  });

  await bus.publishA2A(incoming);
  const outcome = await consumers.waitForOutcome(incoming.id);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.result.askedOwner, true);
  assert.deepEqual(outcome.run.messages.map((item) => item.type), ["acknowledgment", "item_missing"]);
  assert.ok(outcome.run.messages.every((item) => item.correlationId === "integration-workflow"));
  assert.ok(outcome.run.messages.every((item) => item.causationId === incoming.id));
  for (const outbound of outcome.run.messages) await consumers.waitForOutcome(outbound.id);
  assert.ok(audit.history().some((record) => record.toolId === "sdi.inbox" && record.outcome === "allow"));
  assert.ok(audit.history().some((record) => record.toolId === "whatsapp.owner_employees" && record.outcome === "allow"));
  resolveDocumentRequest(outcome.result.requestId, { sdiId: "INTEGRATION-CLEANUP" });
});

test("Lo Smistatore routing runs through its runtime adapter and preserves UI events", async (t) => {
  const calls = [];
  const routing = {
    kind: "routed_task", owner: "l_amministrativo", deadline: new Date().toISOString(),
    sourceMessageType: "correction_request", client: "client-a", escalated: false,
  };
  const h = harness(async (request) => {
    calls.push(request);
    return { status: "completed", artifacts: [routing], messages: [], error: null };
  });
  t.after(async () => { await h.consumers.close(); await h.bus.close(); });
  await h.consumers.start();
  const events = [];
  h.uiBus.subscribe((event) => events.push(event));
  const message = makeMessage({
    from: "l_addetto_iva", to: "lo_smistatore", client: "client-a",
    type: "correction_request", ruleId: "VAT-1", message: "Wrong VAT rate", period: "2026-Q3",
  });

  await h.bus.publishA2A(message);
  await h.consumers.waitForOutcome(message.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].seat, "lo_smistatore");
  assert.equal(calls[0].operation, "route_message");
  assert.deepEqual(events.map((event) => event.channel), ["a2a", "routing", "feed"]);
});

test("unsupported recipient messages fail permanently into dead letters", async (t) => {
  const h = harness(async () => assert.fail("runtime must not run"));
  t.after(async () => { await h.consumers.close(); await h.bus.close(); });
  await h.consumers.start();
  const message = makeMessage({
    from: "lo_smistatore", to: "l_amministrativo", client: "client-a",
    type: "correction_request", ruleId: "VAT-1", message: "Wrong VAT rate", period: "2026-Q3",
  });
  await h.bus.publishA2A(message);
  await waitFor(async () => (await h.bus.deadLetters()).length === 1);
  const [record] = await h.bus.deadLetters();
  assert.equal(record.failure.code, "UNSUPPORTED_RECIPIENT_MESSAGE");
  assert.equal(record.failure.reason, "permanent_failure");
});

test("legacy A2A publication through the UI bus is rejected", () => {
  assert.throws(
    () => publish("a2a", { message: {} }),
    /must use publishA2A/,
  );
});
