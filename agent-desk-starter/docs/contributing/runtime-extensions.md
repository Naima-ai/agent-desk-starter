# Extending the Runtime

## Add an agent operation

Register a snake-case operation in `backend/runtime/defaultRegistry.mjs` with a
strict input schema, the narrowest possible tool list, and a handler returning
`{ artifacts: [...] }`. The active seat manifest must advertise every declared
tool. Do not import a connector directly into the handler; call
`ctx.tools.invoke()` so guardrails and audit execute first.

## Register a tool

Provide input/output schemas plus stable `id`, `action`, `risk`, allowed
locations, client-scope paths, and idempotency metadata. Mutating, external,
payment, and authority tools fail closed if their authorization audit cannot be
written. Add operation, refusal, approval, and cross-client tests.

## Emit A2A

Use `ctx.messages.emit(type, payload, { to })` inside a runtime operation or
`publishA2A(message, { publisher })` at a trusted external ingress. Never call
`publish("a2a", ...)`; the UI bus rejects it. Preserve the incoming correlation
ID and use the incoming message ID as `causationId` for consumer-produced work.

When adding an A2A type, update the strict schema, frontend metadata, routing
competence, all variant tests, and signing golden vectors. Do not silently
accept unknown fields or convert an unverified network message.

## Add a consumer

Give each recipient one stable consumer-group ID and one authoritative consumer
path. Revalidate through `A2ABus`, invoke the engine, persist the business result
before returning, and throw stable retryability-aware errors. Completion is
recorded before transport acknowledgment, so handlers must also use message IDs
as idempotency keys for external writes.

Run `npm test`, then run `npm run test:redis` with Redis 7+ for changes affecting
delivery, recovery, acknowledgment, or dead-letter behavior.

