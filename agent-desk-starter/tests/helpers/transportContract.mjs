import { test } from "node:test";
import assert from "node:assert/strict";

async function waitFor(predicate, { timeoutMs = 1_000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail("Timed out waiting for transport state.");
}

export function registerTransportContract({ name, createHarness, skip = false }) {
  test(`${name}: persists and delivers only to the intended recipient`, { skip }, async (t) => {
    const { transport, cleanup = async () => {} } = await createHarness();
    t.after(cleanup);
    await transport.connect();
    const received = [];
    await transport.consume({ recipient: "agent_a", consumerId: "runtime" }, async (delivery) => {
      received.push(delivery.payload);
      await transport.ack(delivery);
    });
    const persisted = await transport.publish("agent_a", "payload-a", { messageId: "msg-a" });
    await transport.publish("agent_b", "payload-b", { messageId: "msg-b" });
    assert.equal(persisted.persisted, true);
    await waitFor(() => received.length === 1);
    assert.deepEqual(received, ["payload-a"]);
  });

  test(`${name}: nack causes redelivery and ack clears pending work`, { skip }, async (t) => {
    const { transport, cleanup = async () => {} } = await createHarness();
    t.after(cleanup);
    await transport.connect();
    let deliveries = 0;
    await transport.consume({ recipient: "agent_a", consumerId: "runtime" }, async (delivery) => {
      deliveries += 1;
      if (deliveries === 1) await transport.nack(delivery, "retry", { delayMs: 1 });
      else await transport.ack(delivery);
    });
    await transport.publish("agent_a", "payload", { messageId: "msg-retry" });
    if (name === "redis") {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await transport.recover({ recipient: "agent_a", consumerId: "runtime", minIdleMs: 1 });
    }
    await waitFor(() => deliveries === 2, { timeoutMs: 3_000 });
    const health = await transport.health();
    assert.equal(health.pending, 0);
  });

  test(`${name}: abandoned delivery is recovered without concurrent duplication`, { skip }, async (t) => {
    const { transport, cleanup = async () => {} } = await createHarness();
    t.after(cleanup);
    await transport.connect();
    let first = 0;
    const stopFirst = await transport.consume({ recipient: "agent_a", consumerId: "runtime" }, async () => { first += 1; });
    await transport.publish("agent_a", "payload", { messageId: "msg-abandoned" });
    await waitFor(() => first === 1);
    await stopFirst();

    let recovered = 0;
    const handler = async (delivery) => { recovered += 1; await transport.ack(delivery); };
    await transport.consume({ recipient: "agent_a", consumerId: "runtime" }, handler);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await transport.recover({ recipient: "agent_a", consumerId: "runtime", minIdleMs: 0, handler });
    await waitFor(() => recovered === 1, { timeoutMs: 3_000 });
    assert.equal(first, 1);
  });

  test(`${name}: two consumers never receive the same live delivery concurrently`, { skip }, async (t) => {
    const { transport, cleanup = async () => {} } = await createHarness();
    t.after(cleanup);
    await transport.connect();
    const handlers = [];
    const consume = (label) => transport.consume({ recipient: "agent_a", consumerId: "runtime" }, async (delivery) => {
      handlers.push(label);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await transport.ack(delivery);
    });
    await Promise.all([consume("one"), consume("two")]);
    await transport.publish("agent_a", "payload", { messageId: "msg-once" });
    await waitFor(() => handlers.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(handlers.length, 1);
  });

  test(`${name}: permanent failures are visible in the dead-letter store`, { skip }, async (t) => {
    const { transport, cleanup = async () => {} } = await createHarness();
    t.after(cleanup);
    await transport.connect();
    await transport.consume({ recipient: "agent_a", consumerId: "runtime" }, async (delivery) => {
      await transport.deadLetter(delivery, { code: "INVALID", reason: "permanent_failure" });
    });
    await transport.publish("agent_a", "bad-payload", { messageId: "msg-dead" });
    await waitFor(async () => (await transport.deadLetters()).length === 1, { timeoutMs: 3_000 });
    const [record] = await transport.deadLetters();
    assert.equal(record.messageId, "msg-dead");
  });

  test(`${name}: dead letters can be explicitly replayed after repair`, { skip }, async (t) => {
    const { transport, cleanup = async () => {} } = await createHarness();
    t.after(cleanup);
    await transport.connect();
    const stopFailed = await transport.consume({ recipient: "agent_a", consumerId: "runtime" }, async (delivery) => {
      await transport.deadLetter(delivery, { code: "BROKEN", reason: "attempts_exhausted" });
    });
    await transport.publish("agent_a", "recoverable", { messageId: "msg-replay" });
    await waitFor(async () => (await transport.deadLetters()).length === 1, { timeoutMs: 3_000 });
    await stopFailed();

    const received = [];
    await transport.consume({ recipient: "agent_a", consumerId: "runtime" }, async (delivery) => {
      received.push(delivery.payload);
      await transport.ack(delivery);
    });
    const [record] = await transport.deadLetters();
    const replayed = await transport.replayDeadLetter(record.id);
    await waitFor(() => received.length === 1, { timeoutMs: 3_000 });
    assert.equal(replayed.messageId, "msg-replay");
    assert.deepEqual(received, ["recoverable"]);
    assert.equal((await transport.deadLetters()).length, 0);
  });
}

export { waitFor };
