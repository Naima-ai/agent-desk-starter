# Platform Runtime and A2A Roadmap

## Purpose

This plan covers platform runtime and A2A module work:

- agent execution engine;
- centralized runtime guardrails;
- the typed and signed agent-to-agent (A2A) contract;
- reliable message transport; and
- integration of those pieces without breaking the existing demo or frontend.

The individual agents, their business decisions, the model gateway, connectors,
memory implementation, and frontend remain owned by their respective contributors.

## Plan set

- `00-platform-roadmap.md`: scope, decisions, phases, dependencies, and definition
  of done.
- `01-agent-engine-plan.md`: runtime API, registries, execution lifecycle, and
  optional OpenClaw adapter.
- `02-guardrails-plan.md`: policy ordering, immutable refusals, approvals, and
  audit.
- `03-a2a-schema-plan.md`: versioned envelope, Ed25519 signing, keys, replay, and
  compatibility.
- `04-message-bus-plan.md`: transport adapters, Redis/NATS design, delivery,
  retries, dead letters, and SSE compatibility.
- `05-integration-test-rollout-plan.md`: migration, testing, rollout, rollback,
  and release checklist.
- `06-decisions-and-tool-inventory.md`: decision sheet and mapping of every
  current manifest tool to repository code.

## Current baseline

The repository already contains:

- validated seat manifests in `contracts/seats/`;
- a compiler and active-manifest cache in `backend/compiler.mjs`;
- individual agent modules;
- nine A2A message variants in `contracts/a2aSchema.mjs`;
- Lo Smistatore routing wired through `backend/server.mjs`;
- an in-memory `EventEmitter` bus used by both A2A traffic and UI events;
- local refusal checks in L'Amministrativo and Lo Smistatore; and
- a connector-level hard block that prevents autonomous AdE transmission.

The missing platform capabilities are:

- one runtime entry point that executes any seat from its manifest;
- one enforceable policy layer around every tool call;
- cryptographic message verification and replay protection;
- durable A2A delivery, acknowledgment, retry, and deduplication; and
- platform-level security, contract, failure, and restart tests.

## Architecture decisions to confirm

These decisions do not prevent contract and unit-test work from starting, but they
must be settled before runtime and production transport integration is merged.

### D1. Runtime implementation

Recommended: implement a small native runtime behind a stable `runAgent()`
interface. The current workflow is bounded and its agent modules already exist.
This avoids introducing a second model gateway, session store, workspace layout,
and tool system.

Alternative: use real OpenClaw. If this is mandatory, implement an OpenClaw
adapter/plugin behind the same interface. Tool policy and approval enforcement
must use code-level hooks; generated skill prose is not a security boundary.

Decision owner: project lead. Required before Phase 3.

### D2. Durable transport

Recommended: Redis Streams. It fits the current Node service, supports persisted
ordered streams, consumer groups, pending-message recovery, and requires less
runtime restructuring than a separate broker topology.

Alternative: NATS JetStream if the deployment platform already operates NATS or
expects a larger distributed agent fleet.

Only one production adapter will be implemented. The in-memory adapter remains
for tests and offline demos.

Decision owner: project/deployment lead. Required before Phase 4.

### D3. Manifest gate representation

Recommended: replace free-form `gate` strings with structured policy data. During
migration, normalize legacy strings at manifest load time.

Example target:

```json
{
  "gate": {
    "approver": "owner",
    "actions": ["invoice", "external_send"],
    "expiresInSeconds": 900
  }
}
```

Decision owners: runtime owner and compiler owner. Required before guardrail
integration is complete.

## Target boundaries

```text
HTTP / scheduler / A2A consumer
              |
              v
       runAgent(request)
              |
       validated manifest
              |
              v
       agent handler/adapter
              |
       context.tools.invoke()
              |
              v
     guardrails.authorize()
        |       |       |
      allow    deny   approval
        |
        v
      tool registry -> connector / memory / model gateway
        |
        v
   artifact + signed A2A messages -> durable A2A bus
        |
        +-------------------------> UI event bridge/SSE
```

The model never receives or invokes a raw connector function. It can only request
a registered tool, and every invocation crosses the guardrail boundary.

## Delivery phases

### Phase 0: contract freeze and decisions

- Confirm D1-D3.
- Inventory all manifest tool identifiers and map them to implementations.
- Define immutable system refusals separately from generated manifests.
- Agree on the runtime request/result contracts.
- Agree on A2A compatibility and key ownership.

Exit criteria:

- ADR decisions recorded;
- no unresolved naming collision between manifest actions and tool IDs;
- each existing manifest tool is classified as implemented, adapter-needed, or
  intentionally unavailable.

### Phase 1: A2A contract hardening

Implement the work in `03-a2a-schema-plan.md`:

- versioned envelope and unique IDs;
- strict type validation;
- correlation and causation metadata;
- Ed25519 signing and verification;
- key-provider abstraction;
- timestamp, recipient, and replay checks; and
- compatibility helpers and tests.

Exit criteria: invalid or tampered messages cannot reach subscribers.

### Phase 2: centralized guardrails

Status: implemented.

Implement the work in `02-guardrails-plan.md`:

- tool allowlist enforcement;
- non-overridable baseline refusals;
- manifest refusals;
- structured approval gates;
- client and memory-scope checks;
- one-use approval receipts; and
- audit decisions.

Exit criteria: every tool action produces an allow, deny, or approval-required
decision before side effects begin.

### Phase 3: native engine or OpenClaw adapter

Status: implemented using the native engine. The runtime exposes an injectable
message-signing/publishing boundary; production Ed25519 envelopes remain part of
the A2A contract phase, and durable delivery remains Phase 4.

Implement the work in `01-agent-engine-plan.md`:

- runtime request/result schemas;
- agent and tool registries;
- manifest loading;
- guarded tool execution context;
- cancellation, timeouts, and bounded execution;
- signed outbound messages; and
- runtime audit events.

Exit criteria: at least one real existing agent flow executes exclusively through
the engine and guardrails.

### Phase 4: durable A2A bus

Status: implemented with Redis Streams plus the in-memory contract adapter.
Runtime output is durable when `A2A_TRANSPORT=redis`; Phase 5 completed the
legacy producer and active business-consumer cutover.

Implement the work in `04-message-bus-plan.md`:

- split durable A2A traffic from ephemeral UI events;
- transport adapter interface;
- memory adapter contract tests;
- Redis Streams or NATS adapter;
- acknowledgment, retries, recovery, dead-lettering, and idempotency; and
- compatibility wrappers for current server/SSE consumers.

Exit criteria: an unacknowledged A2A message survives a process restart and is
redelivered without duplicating a completed action.

### Phase 5: migration and end-to-end cutover

Status: implemented for the platform-owned dispatcher and first client-agent
vertical flow. All repository A2A producers use durable admission, the old HTTP
subscriber is removed, and one consumer path owns each active recipient.
Production release remains blocked on the Phase 1 Ed25519 envelope/key work and
on migration of business operations owned by the remaining seat modules.

Implement the work in `05-integration-test-rollout-plan.md`:

- migrate one vertical flow first;
- remove direct unguarded connector calls from migrated paths;
- move A2A routing subscribers out of HTTP server bootstrap where appropriate;
- prevent legacy and new consumers from processing the same message twice;
- retain the existing SSE event shape; and
- run the full VAT demo and security regression suite.

Exit criteria: the demo completes through the runtime and durable bus, while AdE
transmission remains impossible for an agent.

## Proposed pull requests

1. `contracts: version and verify A2A envelopes`
2. `runtime: add centralized guardrails and approval receipts`
3. `runtime: add agent engine and registries`
4. `messaging: add adapter-backed A2A bus`
5. `integration: migrate dispatcher and one client-agent flow`
6. `hardening: restart, replay, failure, and end-to-end tests`

Each PR should keep `node --test` green and preserve the current frontend event
contract.

## Coordination points

| Collaborator area | Agreement needed |
|---|---|
| Compiler/model gateway | Structured gate format, active-manifest API, and whether OpenClaw is mandatory |
| Agent owners | Stable operation names and adapter inputs/outputs |
| Dispatcher owner | Which component owns routing consumption and acknowledgments |
| Connector owners | Tool IDs, input schemas, idempotency keys, and irreversible side effects |
| Memory owner | Enforceable read/write layers and client partition contract |
| Frontend owner | Preserve SSE channels and introduce envelope fields without UI regression |
| Deployment owner | Redis or NATS, secret storage, key rotation, health checks, and observability |

## Global definition of done

- Every runtime execution uses a validated manifest.
- An agent sees only registered tools allowed by its manifest.
- System refusals cannot be weakened by edited or model-generated manifests.
- Gated actions cannot start before a valid, bound approval is consumed.
- All A2A messages are strict, versioned, signed, verified, and replay-protected.
- A2A delivery is durable and at-least-once; consumers are idempotent.
- Failed messages are retried and eventually visible in a dead-letter stream.
- Security and execution decisions are auditable without logging secrets.
- The AdE connector still refuses autonomous transmission at the connector layer.
- The existing frontend continues to receive its current SSE channels.
- The full VAT scenario and all new contract/security/restart tests pass.

## Explicit non-goals for this work

- Rewriting VAT, classification, routing, or archivist business logic.
- Replacing the shared model gateway.
- Implementing connector internals owned by other contributors.
- Building exactly-once distributed processing. The design uses at-least-once
  delivery plus idempotent consumers.
- Treating prompts, generated skill text, or manifest prose as hard security.
