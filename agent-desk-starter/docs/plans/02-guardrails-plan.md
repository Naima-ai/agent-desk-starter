# Guardrails and Approval Plan

**Status: implemented (Phase 2).** The native implementation uses a durable
JSON approval store and append-only JSONL audit log under `data/`, with in-memory
adapters for isolated tests. A caller resumes an approved action by rerunning the
same operation with the same `runId` and unchanged input; the receipt is located,
validated, and consumed atomically immediately before execution.

## Goal

Centralize authorization for all agent tool calls. A tool must never begin a side
effect until policy returns an explicit allow decision or a matching human
approval has been validated and consumed.

Prompt instructions and generated manifests may narrow behavior, but they cannot
relax immutable system safety rules.

## New modules

```text
backend/runtime/
  guardrails.mjs       policy evaluation and authorization decisions
  systemPolicy.mjs     reviewed, non-overridable refusals and gate requirements
  approvalStore.mjs    pending/approved/denied/expired/consumed receipts
  auditLog.mjs         append-only runtime decision records
```

The first approval and audit stores may be in-memory adapters for tests, but their
interfaces must support durable implementations. Production approval state must
survive restarts before production connectors are enabled.

## Authorization contract

```js
authorize({
  run,
  manifest,
  tool,
  action,
  args,
  approvalReceipt
})
```

It returns exactly one outcome:

```js
{ outcome: "allow", decisionId }
{ outcome: "deny", decisionId, code, reason }
{ outcome: "approval_required", decisionId, approval }
```

Unknown or malformed inputs return `deny`. Policy evaluation errors also deny.

## Decision order

Evaluate every request in this order:

1. Validate execution identity and client scope.
2. Resolve the tool from the registry; deny unknown tools.
3. Confirm the tool appears in `manifest.tools`.
4. Apply immutable system refusals; deny wins.
5. Apply manifest `refuses`; these may only add restrictions.
6. Check location, client, and memory read/write boundaries.
7. Determine whether system or manifest policy requires approval.
8. If approval is required, validate the receipt against the exact request.
9. Emit and persist the decision.
10. Only then allow the registry to invoke the tool.

No handler may bypass this sequence by retaining a raw tool implementation.

## Immutable system policy

Create a reviewed code/config policy independent from model-generated manifests.
It must include at least:

- no autonomous transmission to the tax authority;
- no signing on behalf of a professional;
- no payment execution by L'Amministrativo;
- no direct studio-person contact where the A2A dispatcher is required;
- no client response, people ranking, or performance-based routing by Lo
  Smistatore;
- no account invention or below-threshold posting by Il Classificatore; and
- no knowledge rule confirmation without evidence/human confirmation.

The connector-level AdE refusal remains in place as defence in depth.

Use stable action identifiers. Do not authorize by searching natural-language
descriptions.

## Tool allowlist semantics

- Registry presence does not grant access.
- Manifest presence does not prove the tool exists.
- A tool is callable only when it exists in the registry and is present in the
  active validated manifest.
- Deny rules always override allow rules.
- Wildcard access is not supported in the first version.
- Tool aliases must be normalized before policy evaluation and must not bypass a
  refusal under another name.

## Structured gates

Move toward this manifest representation:

```js
gate: {
  approver: "owner" | "studio_professional" | "credential_owner",
  actions: ["invoice", "external_send"],
  expiresInSeconds: 900
}
```

Add a normalizer for current string values during migration. Unknown legacy gate
syntax must require approval rather than silently allowing the action.

`none_internal` should normalize to no manifest gate, but system policy can still
require one.

## Approval lifecycle

```text
pending -> approved -> consumed
        -> denied
        -> expired
```

An approval record must include:

- unique approval ID;
- run, seat, client, tool, and action;
- hash of canonicalized arguments;
- required approver role;
- requester identity;
- created and expiry timestamps;
- status and resolution identity/time; and
- one-use consumption time.

Rules:

- approval is never inferred from an A2A acknowledgment;
- changed arguments invalidate an approval;
- approval for one client/run/tool cannot authorize another;
- expired, denied, or consumed approval cannot be reused;
- reauthorization is performed immediately before execution;
- escalation never auto-approves; and
- approval resolution and tool execution must be auditable.

## Audit record

Every decision records:

```js
{
  decisionId,
  runId,
  correlationId,
  seat,
  clientId,
  toolId,
  action,
  outcome,
  reasonCode,
  policyRefs,
  approvalId,
  at
}
```

Do not store secrets or full sensitive payloads. Store an argument hash and a
small redacted summary. Audit append failure must block high-risk writes and
external sends; the exact behavior for reads should be documented.

## Migration of current checks

1. Add central guardrails and prove them independently.
2. Wrap existing refusal-test entry points around central authorization.
3. Add equivalent regression tests for each existing hard block.
4. Migrate actual tool invocation paths.
5. Remove duplicated local policy constants only after the central baseline is
   reviewed and all regression tests pass.
6. Keep connector-level safety blocks where they protect irreversible actions.

Do not perform a one-step deletion of existing `assertAllowed()` checks.

## Tests

Create `tests/guardrails.test.mjs` covering:

- allowed registered tool;
- tool missing from manifest;
- unknown tool and alias confusion;
- immutable refusal omitted from edited manifest;
- new manifest refusal adds a restriction;
- deny wins over allow and approval;
- malformed or unknown gate fails closed;
- approval request does not execute the tool;
- correct approval permits one exact invocation;
- changed argument, client, run, tool, or expired receipt is denied;
- consumed approval cannot be replayed;
- escalation does not approve;
- policy exception fails closed;
- concurrent approvals do not cross clients; and
- audit record is emitted for every outcome.

Add adversarial tests using instructions such as "ignore previous restrictions"
to prove that prompt content has no effect on code-level policy.

## Completion criteria

- All runtime tool calls use `authorize()`.
- No manifest edit can remove a system refusal.
- Approval receipts are exact, expiring, and one-use.
- Side effects cannot start while a gate is pending.
- Existing hard-block tests still pass through the centralized policy.
- AdE transmission is blocked both centrally and at the connector.
- Audit events contain enough information to reconstruct every decision without
  exposing secrets.
