import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerTransportContract } from "./helpers/transportContract.mjs";
import { RedisStreamsTransport } from "../backend/messaging/redisStreamsTransport.mjs";
import { waitFor } from "./helpers/transportContract.mjs";

const enabled = Boolean(process.env.REDIS_URL);

registerTransportContract({
  name: "redis",
  skip: enabled ? false : "REDIS_URL is not configured",
  createHarness: async () => {
    const prefix = `agentdesk:test:${randomUUID()}`;
    const transport = new RedisStreamsTransport({
      prefix, blockMs: 20, claimMinIdleMs: 10, recoveryIntervalMs: 10_000,
    });
    return {
      transport,
      cleanup: async () => {
        const client = transport.client;
        if (client?.isOpen) {
          for await (const key of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) await client.del(key);
        }
        await transport.close();
      },
    };
  },
});

test("redis: queued and unacknowledged messages survive transport restart", {
  skip: enabled ? false : "REDIS_URL is not configured",
}, async () => {
  const prefix = `agentdesk:test:restart:${randomUUID()}`;
  const first = new RedisStreamsTransport({ prefix, blockMs: 20, claimMinIdleMs: 5, recoveryIntervalMs: 10_000 });
  await first.connect();
  await first.publish("agent_a", "queued", { messageId: "queued-id" });
  let abandoned = 0;
  const stop = await first.consume({ recipient: "agent_b", consumerId: "runtime" }, async () => { abandoned += 1; });
  await first.publish("agent_b", "unacked", { messageId: "unacked-id" });
  await waitFor(() => abandoned === 1, { timeoutMs: 3_000 });
  await stop();
  await first.close();

  const second = new RedisStreamsTransport({ prefix, blockMs: 20, claimMinIdleMs: 5, recoveryIntervalMs: 10_000 });
  await second.connect();
  const received = [];
  await second.consume({ recipient: "agent_a", consumerId: "runtime" }, async (delivery) => {
    received.push(delivery.messageId);
    await second.ack(delivery);
  });
  const recoverHandler = async (delivery) => {
    received.push(delivery.messageId);
    await second.ack(delivery);
  };
  await second.consume({ recipient: "agent_b", consumerId: "runtime" }, recoverHandler);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await second.recover({ recipient: "agent_b", consumerId: "runtime", minIdleMs: 0, handler: recoverHandler });
  await waitFor(() => received.length === 2, { timeoutMs: 3_000 });
  assert.deepEqual(new Set(received), new Set(["queued-id", "unacked-id"]));

  const client = second.client;
  for await (const key of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) await client.del(key);
  await second.close();
});
