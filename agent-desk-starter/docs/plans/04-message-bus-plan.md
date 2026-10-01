# Message Bus Plan

**Status: implemented (roadmap Phase 4).** Redis Streams is the selected durable
production adapter; the deterministic in-memory adapter remains the default for
tests and offline demos. Runtime-produced A2A messages use the durable facade.
Legacy direct `publish("a2a", ...)` scenario/server producers remain UI-only
compatibility calls and are explicitly scheduled for the Phase 5 cutover.

Operational endpoints:

- `GET /api/a2a-health` — connectivity, queued/pending counts, pending age,
  dead-letter count, and last transport error/success;
- `GET /api/a2a-dead-letters` — sanitized failure metadata without message
  payloads.

## Goal

Provide durable, at-least-once A2A delivery with validation, acknowledgment,
retry, recovery, deduplication, and dead-letter visibility while preserving the
current lightweight event stream used by the frontend.

Exactly-once delivery is not promised. Logical exactly-once behavior comes from
stable message IDs and idempotent consumers.

## Separate two concerns

The current `bus.mjs` mixes:

1. domain-critical A2A messages; and
2. ephemeral UI events such as `feed`, `board`, `gate`, and `knowledge`.

Split their APIs while keeping temporary compatibility wrappers.

```js
// Durable, typed, authenticated
publishA2A(message)
subscribeA2A({ recipient, consumerId }, handler)

// Ephemeral frontend/demo telemetry
publishUi(channel, event)
subscribeUi(handler)
uiHistory(options)
```

Legacy `publish/subscribe/history` can delegate to the UI side during migration.
Publishing to channel `a2a` through the legacy API should eventually be rejected.

## Modules

```text
backend/messaging/
  a2aBus.mjs              verification + transport-neutral facade
  transport.mjs           adapter contract
  inMemoryTransport.mjs   deterministic tests/offline demo
  redisStreamsTransport.mjs or natsTransport.mjs
  idempotencyStore.mjs
  retryPolicy.mjs
  uiBus.mjs               bounded EventEmitter/SSE source
backend/bus.mjs            temporary compatibility exports
```

Implemented as listed above, using `redisStreamsTransport.mjs` for production.

## Transport adapter contract

The adapter must support:

- `connect()` / `close()`;
- `health()`;
- `publish(recipient, serializedEnvelope)`;
- `consume({recipient, consumerId}, handler)`;
- `ack(delivery)`;
- `nack(delivery, reason)`;
- recovery of abandoned/pending deliveries; and
- dead-letter publication.

Business validation and signing remain outside the adapter. This lets the same
contract tests run against memory and production transports.

## Publish path

1. Accept only an A2A v2 envelope.
2. Strictly parse and verify the signature.
3. Confirm publisher identity matches `message.from`.
4. Validate recipient existence/authorization.
5. Check the admitted-message ID store.
6. Persist the message before reporting publish success.
7. Emit a sanitized UI copy to the A2A stream.

If persistence fails, do not emit a success UI event or tell the caller the
message was delivered.

## Consume path

1. Receive a persisted delivery for the intended recipient.
2. Revalidate schema and signature defensively.
3. Check `(consumerId, message.id)` completion state.
4. If already completed, acknowledge without re-running the handler.
5. Execute the consumer/runtime handler with message correlation metadata.
6. Mark completion durably.
7. Acknowledge the transport delivery.
8. On failure, record attempt metadata and apply retry policy.

The completion marker must be written before acknowledgment. Connector writes
must also carry the message ID or run idempotency key where supported.

## Redis Streams topology (recommended option)

If Redis is selected:

- one stream per recipient: `agentdesk:a2a:<recipient>`;
- one runtime consumer group per recipient;
- message envelope stored as immutable serialized JSON;
- pending entries recovered with the Redis pending/claim mechanism;
- retry attempt state stored outside the signed envelope;
- dead-letter stream: `agentdesk:a2a:dead-letter`; and
- admitted/completed ID keys retained for at least the message retention window.

Define retention limits deliberately. Do not use unbounded streams or unbounded
frontend history.

## NATS JetStream topology (alternative)

If NATS is selected:

- subjects such as `agentdesk.a2a.<recipient>.<type>`;
- durable consumer per runtime recipient;
- explicit acknowledgments;
- configured redelivery/backoff and maximum deliveries;
- dead-letter/advisory consumer; and
- message ID used for broker deduplication plus application idempotency.

Do not maintain Redis and NATS production implementations simultaneously for this
project milestone.

## Retry policy

Classify failures:

- validation, signature, authorization: permanent; reject/dead-letter without
  normal retry;
- unknown recipient/tool/operation: configuration failure; limited retry then
  dead-letter;
- timeout, connection, transient connector error: retry with exponential backoff
  and jitter;
- policy denial: completed refusal, not a retryable transport failure;
- approval required: acknowledge the triggering message after durable approval
  state is created; resume through a new correlated approval-resolution event.

Configure maximum attempts and maximum age. Dead-letter records must include the
original signed envelope plus sanitized failure metadata.

## Ordering and concurrency

- Preserve order within a recipient stream where practical.
- Do not rely on global ordering across recipients.
- Limit concurrent deliveries per consumer.
- Use client/correlation locks where two messages could mutate the same workflow.
- Long-running work should use bounded runtime calls and lease/heartbeat behavior
  rather than leaving messages invisibly pending forever.

## Server and UI compatibility

The current frontend consumes `/events` and buckets events by `channel`.

During migration:

- keep the existing channel names and event shapes;
- bridge admitted/consumed A2A messages into `uiBus`;
- use a bounded in-memory UI history, e.g. last N events;
- do not replay the entire durable A2A stream on every SSE connection; and
- keep UI failure from affecting durable A2A acknowledgment.

Move the Lo Smistatore A2A subscriber out of incidental HTTP server wiring once
the durable runtime consumer is ready. Ensure only one of the legacy subscriber
and new consumer is enabled during cutover.

## Configuration and operations

Proposed environment variables:

```text
A2A_TRANSPORT=memory|redis
REDIS_URL=...
A2A_MAX_ATTEMPTS=...
A2A_RETENTION=...
UI_HISTORY_LIMIT=...
```

Only variables relevant to the selected production adapter should be required.

Expose health information:

- transport connected;
- publish/consume readiness;
- pending and oldest pending age;
- retry and dead-letter counts; and
- consumer last-success timestamp.

Never log complete messages containing sensitive business data by default.

## Tests

Create a reusable transport contract suite and run it against memory plus the
selected production adapter.

Cover:

- persist-before-success behavior;
- delivery only to intended recipient;
- acknowledgment removes pending work;
- failure causes redelivery;
- restart/abandoned delivery recovery;
- same message ID is not logically processed twice;
- concurrent consumers do not both complete one delivery;
- permanent invalid messages are dead-lettered;
- transient failure respects backoff and maximum attempts;
- approval-required flow does not hold a transport delivery indefinitely;
- UI subscriber failure does not fail A2A processing;
- bounded UI and stream retention; and
- graceful shutdown stops intake and settles/returns in-flight work.

Production-adapter tests should run in a separate integration-test command when
the broker is available; the normal unit suite stays self-contained.

## Completion criteria

- A2A messages survive service restart.
- Unacknowledged work is recovered.
- Invalid/tampered messages never reach business consumers.
- Duplicate delivery does not duplicate completed business action.
- Repeated failures become visible dead-letter entries.
- The UI continues receiving its existing SSE channels.
- Memory and production transports pass the same behavioral contract suite.
