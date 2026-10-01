# Integration, Testing, and Rollout Plan

## Goal

Introduce the engine, guardrails, A2A v2 contract, and durable transport without
breaking the existing VAT scenario, double-processing messages, or weakening any
safety control.

## Integration sequence

### 1. Freeze observable behavior

Before migration, add characterization tests for:

- current A2A messages produced by each module;
- Lo Smistatore routing outcomes;
- L'Amministrativo approval and escalation behavior;
- the full VAT scenario's final state; and
- SSE channel names required by the frontend.

These tests protect behavior while internal ownership moves.

### 2. Introduce contracts without cutover

- Add runtime, guardrail, transport, and A2A v2 schemas.
- Keep legacy execution active.
- Add adapters around existing functions.
- Use deterministic injected clocks, IDs, and keys in tests.

### 3. Migrate one vertical flow

Pilot:

```text
instruction_from_studio
  -> durable A2A admission
  -> l_amministrativo runtime consumer
  -> guarded tools
  -> acknowledgment/result A2A
  -> UI bridge
```

Verify the same user-visible behavior and new audit/delivery evidence.

### 4. Migrate dispatcher routing

- Consume messages addressed to `lo_smistatore` through the A2A bus.
- Call routing through the runtime adapter.
- Publish routing telemetry to the UI bus.
- Acknowledge only after the routing result is durable/published.
- Disable the old `server.mjs` subscriber in the same cutover.

### 5. Migrate remaining agent entry points

For each operation:

- inventory current direct imports and side effects;
- register required tools;
- route invocation through runtime context;
- add operation contract tests;
- enable the new path; and
- remove the old bypass only after tests prove parity.

### 6. Harden and remove compatibility mode

- Reject v1 messages outside explicitly enabled development migration mode.
- Reject legacy A2A publication through generic UI `publish()`.
- Remove duplicated guardrail code after central-policy parity is proven.
- Update README and architecture documentation.

## Feature switches

Use narrowly scoped migration switches, not permanent alternate architectures:

```text
RUNTIME_ENGINE_ENABLED=true|false
A2A_V1_MIGRATION_ENABLED=true|false
A2A_TRANSPORT=memory|redis|nats
```

Rules:

- defaults stay safe and documented;
- production must not enable unsigned v1 input;
- only one consumer path may own a recipient at a time; and
- feature-switch removal is part of the milestone definition of done.

## Test strategy

### Unit tests

- runtime request/result schemas;
- tool and agent registries;
- guardrail decisions and approval state machine;
- all A2A variants and cryptography;
- retry classification and idempotency;
- legacy normalization during migration.

### Contract tests

- all agent adapters produce runtime results;
- all registered tools validate inputs/outputs;
- all bus adapters implement the same delivery behavior;
- every seat manifest references valid or explicitly unavailable tool IDs; and
- UI events preserve their documented shape.

### Integration tests

- A2A -> engine -> guarded tool -> A2A;
- dispatcher routing through transport;
- human approval pause and resume;
- connector transient failure and retry;
- broker/service restart recovery;
- key rotation overlap and old-key revocation; and
- dead-letter inspection/replay procedure.

### End-to-end tests

- full VAT validation/remediation scenario;
- low-confidence human gate;
- missing-document request, reminder, escalation, and resolution;
- knowledge/evidence update after confirmation;
- prepare-only AdE path; and
- frontend SSE receives A2A, board, gate, routing, evidence, and knowledge events.

### Security/adversarial tests

- prompt requests to ignore refusals;
- edited manifest omitting a hard refusal;
- unregistered tool name and look-alike alias;
- tampered signature and spoofed sender;
- replayed message/approval;
- cross-client message and approval attempt;
- oversized payload and unexpected fields;
- expired message and approval; and
- policy/audit subsystem failure.

## Required acceptance scenarios

| Scenario | Expected result |
|---|---|
| Manifest does not list a tool | Tool is unavailable and no implementation runs |
| Generated manifest omits a system refusal | System refusal still denies |
| Agent attempts AdE transmission | Runtime denies; connector also refuses if reached |
| Gated action has no approval | Durable pending approval; no side effect |
| Approved arguments are changed | Receipt rejected |
| A2A payload is malformed | Rejected before persistence/delivery |
| Signed message is modified | Signature verification fails |
| Same delivery returns after crash | Consumer resumes without duplicating completed action |
| Handler repeatedly fails | Message reaches dead-letter stream with reason |
| UI connection fails | Durable A2A processing continues |
| Full demo runs | Same user-visible outcome through new platform path |

## Observability

Add structured events/metrics for:

- runtime runs by status and duration;
- tool calls by allow/deny/approval-required outcome;
- approval age and resolution;
- A2A publish, verify, consume, retry, and dead-letter counts;
- oldest pending delivery;
- duplicate/replay detections; and
- connector/runtime errors by stable code.

Use IDs and redacted metadata. Do not emit private keys, tokens, full invoices, or
unbounded prompts into logs.

## Rollback

- Contract/schema PRs remain additive until all producers are migrated.
- Runtime migration happens operation by operation.
- A recipient has only one active consumer implementation.
- If a new consumer is disabled, stop it cleanly before enabling the legacy path.
- Never roll back by accepting unsigned network messages in production.
- Preserve pending approvals and durable messages across deployment rollback.

## Documentation deliverables

Before completion, update:

- `README.md`: runtime, selected broker, configuration, and test commands;
- `ARCHITECTURE.md`: actual file paths and nine A2A types;
- operator runbook: broker/key health, pending recovery, dead-letter handling,
  key rotation, and approval troubleshooting; and
- contributor guide: adding an agent operation, registering a tool, adding an A2A
  type, and writing an idempotent consumer.

## Final release checklist

- [ ] D1-D3 decisions recorded.
- [ ] Every manifest tool inventoried.
- [ ] All production A2A producers use v2 signing.
- [ ] All production consumers verify before processing.
- [ ] Central guardrails wrap all migrated tools.
- [ ] Approval receipts are durable and one-use.
- [ ] Selected durable transport passes contract/restart tests.
- [ ] No recipient has both legacy and new consumers active.
- [ ] AdE autonomous transmission tests pass.
- [ ] Full unit, integration, security, and demo suites pass.
- [ ] UI/SSE regression check passes.
- [ ] Secrets and private keys are absent from source and logs.
- [ ] Dead-letter and recovery runbooks have been exercised once.
- [ ] Migration flags have owners and removal dates.

