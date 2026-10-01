import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMessage } from "../contracts/a2aSchema.mjs";
import { A2ABus } from "../backend/messaging/a2aBus.mjs";
import { MemoryIdempotencyStore } from "../backend/messaging/idempotencyStore.mjs";
import { InMemoryTransport, createInMemoryTransportState } from "../backend/messaging/inMemoryTransport.mjs";
import { createRetryPolicy } from "../backend/messaging/retryPolicy.mjs";
import { UiBus } from "../backend/messaging/uiBus.mjs";
import { waitFor } from "./helpers/transportContract.mjs";

function message(overrides = {}) {
  return makeMessage({
    from: "sender", to: "receiver", client: "client-a",
    type: "acknowledgment", ref: "ref-a", ...overrides,
  });
}

async function harness({ transport = new InMemoryTransport(), idempotencyStore = new MemoryIdempotencyStore(), uiBus = new UiBus(), retryPolicy } = {}) {
  const bus = new A2ABus({
    transport, idempotencyStore, uiBus,
    retryPolicy: retryPolicy || createRetryPolicy({ maxAttempts: 3, baseDelayMs: 0, jitter: 0 }),
  });
  await bus.connect();
  return { bus, transport, idempotencyStore, uiBus };
}

test("publish persists before success and emits the compatible UI event afterward", async (t) => {
  const h = await harness();
  t.after(() => h.bus.close());
  const events = [];
  h.uiBus.subscribe((event) => events.push(event));
  const outbound = message();

  const result = await h.bus.publishA2A(outbound, { publisher: "sender" });

  assert.equal(result.status, "persisted");
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, "a2a");
  assert.equal(events[0].message.id, outbound.id);
  assert.equal((await h.transport.health()).queued, 1);
});

test("persistence failure reports failure, emits no UI event, and releases admission", async (t) => {
  const transport = new InMemoryTransport();
  const originalPublish = transport.publish.bind(transport);
  let fail = true;
  transport.publish = (...args) => fail ? Promise.reject(new Error("disk unavailable")) : originalPublish(...args);
  const h = await harness({ transport });
  t.after(() => h.bus.close());
  const outbound = message();

  await assert.rejects(h.bus.publishA2A(outbound), (error) => error.code === "A2A_PERSIST_FAILED");
  assert.equal(h.uiBus.history().length, 0);
  fail = false;
  assert.equal((await h.bus.publishA2A(outbound)).status, "persisted");
});

test("same signed message is admitted once while same ID with new content is rejected", async (t) => {
  const h = await harness();
  t.after(() => h.bus.close());
  const outbound = message();
  assert.equal((await h.bus.publishA2A(outbound)).status, "persisted");
  assert.equal((await h.bus.publishA2A(outbound)).status, "duplicate");

  const conflicting = message({ id: outbound.id, ref: "different" });
  await assert.rejects(h.bus.publishA2A(conflicting), (error) => error.code === "MESSAGE_ID_CONFLICT");
  assert.equal((await h.transport.health()).queued, 1);
});

test("publisher identity mismatch is rejected before persistence", async (t) => {
  const h = await harness();
  t.after(() => h.bus.close());
  await assert.rejects(
    h.bus.publishA2A(message(), { publisher: "impostor" }),
    (error) => error.code === "PUBLISHER_MISMATCH",
  );
  assert.equal((await h.transport.health()).queued, 0);
});

test("tampered persisted messages are dead-lettered before business handlers", async (t) => {
  const h = await harness();
  t.after(() => h.bus.close());
  let calls = 0;
  await h.bus.subscribeA2A({ recipient: "receiver", consumerId: "runtime" }, async () => { calls += 1; });
  const tampered = { ...message(), ref: "changed-after-signing" };
  await h.transport.publish("receiver", JSON.stringify(tampered), { messageId: tampered.id });

  await waitFor(async () => (await h.bus.deadLetters()).length === 1);
  assert.equal(calls, 0);
  assert.equal((await h.bus.deadLetters())[0].failure.code, "INVALID_A2A_SIGNATURE");
});

test("transient failures retry with a limit and then become dead letters", async (t) => {
  const h = await harness();
  t.after(() => h.bus.close());
  let calls = 0;
  await h.bus.subscribeA2A({ recipient: "receiver", consumerId: "runtime" }, async () => {
    calls += 1;
    const error = new Error("temporary connector outage");
    error.code = "CONNECTOR_UNAVAILABLE";
    error.retryable = true;
    throw error;
  });
  await h.bus.publishA2A(message());

  await waitFor(async () => (await h.bus.deadLetters()).length === 1);
  assert.equal(calls, 3);
  assert.equal((await h.bus.deadLetters())[0].failure.reason, "attempts_exhausted");
});

test("completed message IDs are acknowledged without repeating business work", async (t) => {
  const h = await harness();
  t.after(() => h.bus.close());
  let calls = 0;
  await h.bus.subscribeA2A({ recipient: "receiver", consumerId: "runtime" }, async () => { calls += 1; });
  const outbound = message();
  await h.bus.publishA2A(outbound);
  await waitFor(() => calls === 1);
  await h.transport.publish("receiver", JSON.stringify(outbound), { messageId: outbound.id });
  await waitFor(async () => (await h.transport.health()).queued === 0 && (await h.transport.health()).pending === 0);
  assert.equal(calls, 1);
});

test("approval-required and refusal results complete transport delivery", async (t) => {
  const h = await harness();
  t.after(() => h.bus.close());
  await h.bus.subscribeA2A({ recipient: "receiver", consumerId: "runtime" }, async () => ({ status: "awaiting_approval" }));
  await h.bus.publishA2A(message());
  await waitFor(async () => (await h.transport.health()).queued === 0 && (await h.transport.health()).pending === 0);
  assert.equal((await h.bus.deadLetters()).length, 0);
});

test("queued messages survive a bus restart and are consumed afterward", async (t) => {
  const transportState = createInMemoryTransportState();
  const idempotencyState = { admitted: new Map(), completed: new Map() };
  const first = await harness({
    transport: new InMemoryTransport({ state: transportState }),
    idempotencyStore: new MemoryIdempotencyStore({ state: idempotencyState }),
  });
  await first.bus.publishA2A(message());
  await first.bus.close();

  const second = await harness({
    transport: new InMemoryTransport({ state: transportState }),
    idempotencyStore: new MemoryIdempotencyStore({ state: idempotencyState }),
  });
  t.after(() => second.bus.close());
  let calls = 0;
  await second.bus.subscribeA2A({ recipient: "receiver", consumerId: "runtime" }, async () => { calls += 1; });
  await waitFor(() => calls === 1);
});

test("UI failures are isolated and UI history is bounded", async (t) => {
  const uiBus = new UiBus({ historyLimit: 2 });
  uiBus.subscribe(() => { throw new Error("closed SSE socket"); });
  const seen = [];
  uiBus.subscribe((event) => seen.push(event.channel));
  const h = await harness({ uiBus });
  t.after(() => h.bus.close());

  await h.bus.publishA2A(message({ ref: "one" }));
  uiBus.publish("feed", { text: "two" });
  uiBus.publish("board", { text: "three" });
  assert.deepEqual(seen, ["a2a", "feed", "board"]);
  assert.deepEqual(uiBus.history().map((event) => event.channel), ["feed", "board"]);
});

test("graceful shutdown stops new intake", async () => {
  const h = await harness();
  await h.bus.close();
  await assert.rejects(h.bus.publishA2A(message()), (error) => error.code === "A2A_BUS_CLOSED");
});
