# Agent Engine Plan

**Status: implemented (roadmap Phase 3).** The selected implementation is the
native Node.js runtime. OpenClaw remains an optional future adapter behind the
same public contract, not a dependency of this phase.

## Goal

Provide one runtime API that can execute any seat from its validated active
manifest, with a restricted tool context, centralized guardrails, structured
results, and signed A2A output.

The recommended first implementation is native Node.js. A future OpenClaw adapter
must implement the same public interface so callers and tests remain unchanged.

## Implementation status

Implemented in the native runtime:

- strict runtime request/result contracts;
- `runAgent()` and an injectable engine factory;
- agent and tool registries;
- immutable run identity and scoped execution context;
- manifest validation, tool allowlisting, baseline refusals, and approval-required
  outcomes;
- time, cancellation, payload, artifact, tool-call, and message limits;
- structured public errors and durable runtime audit events;
- typed A2A emission with correlation IDs;
- an injectable outbound message/signing factory, with validation before publish;
- startup validation of every business tool advertised by enabled-seat manifests;
- operation-level tool capability lists in addition to seat-wide manifest lists;
- the guarded `instruction_from_studio -> l_amministrativo` vertical slice;
- the guarded `l_addetto_iva -> ade.prepare_only` slice; and
- engine/security/isolation regression tests.

The OpenClaw adapter remains intentionally unimplemented because the native
runtime was selected. Durable transport and durable reminder scheduling belong
to Phase 4. The engine's signing boundary is ready for the A2A v2 Ed25519
provider; the default remains the repository's development signer until that
separate contract migration is completed.

## Public contract

Add runtime request and result schemas, preferably in
`contracts/runtimeSchema.mjs`.

Proposed request:

```js
{
  runId,                 // optional at input; generated when absent
  seat,                  // manifest seat ID
  operation,             // stable agent operation/trigger name
  input,                 // operation-specific data
  context: {
    clientId,
    correlationId,
    causationId,
    actor,               // system, agent:<seat>, or human:<id>
    deadline
  }
}
```

Proposed result:

```js
{
  runId,
  seat,
  status: "completed" | "awaiting_approval" | "refused" | "failed",
  artifacts: [],
  messages: [],
  approval: null,
  error: null,
  startedAt,
  finishedAt
}
```

Errors exposed to callers must use stable codes. Stack traces and connector
secrets stay in server-side diagnostics only.

## New modules

```text
backend/runtime/
  agentEngine.mjs        public runAgent() entry point
  agentRegistry.mjs      seat + operation -> handler adapter
  toolRegistry.mjs       tool ID -> typed implementation and metadata
  executionContext.mjs   guarded tools, identity, cancellation, audit helpers
  openclawAdapter.mjs    optional; only if real OpenClaw is mandated
```

Do not call the native implementation `openclaw.mjs` unless it actually invokes
OpenClaw. `agentEngine.mjs` is the truthful neutral boundary.

## Runtime lifecycle

For every `runAgent()` call:

1. Parse the request schema and generate `runId`/`correlationId` when absent.
2. Load `getActiveManifest(seat)` and revalidate it with `ManifestSchema`.
3. Resolve the requested seat and operation in `agentRegistry`.
4. Build a scoped execution context containing:
   - immutable agent identity;
   - client and correlation identity;
   - cancellation/deadline signal;
   - guarded `tools.invoke(toolId, args)`;
   - `messages.emit(type, payload)`; and
   - audit helpers.
5. Execute the handler within configured time and step limits.
6. Validate every artifact and outbound A2A message.
7. Sign and publish outbound messages only after successful validation.
8. Return the structured result and final audit event.

Every exception must become a structured `failed` result at the external boundary.
Policy denials and approval waits are expected states, not generic failures.

## Agent registry

The existing agent modules do not expose a uniform API. Add thin adapters instead
of rewriting their logic.

Example shape:

```js
registerAgent({
  seat: "l_amministrativo",
  operations: {
    collect_document: async (input, ctx) => { /* adapt existing function */ },
    handle_instruction: async (input, ctx) => { /* adapt existing function */ }
  }
});
```

Registry rules:

- duplicate seats or operation names fail at startup;
- unknown seats/operations fail closed;
- handlers receive no raw connector modules;
- handlers receive the validated manifest and guarded execution context; and
- adapters translate legacy return values into runtime artifacts/messages.

## Tool registry

Each manifest tool identifier must resolve to one registry record:

```js
registerTool({
  id: "ade.prepare_only",
  action: "prepare_submission",
  risk: "write",
  inputSchema,
  outputSchema,
  idempotent: true,
  execute: async (args, ctx) => { /* connector call */ }
});
```

Required metadata:

- stable `id` matching seat manifests;
- stable policy `action`;
- risk class: `read`, `write`, `external_send`, `payment`, `authority`;
- input and output schemas;
- idempotency behavior;
- whether human approval can be required; and
- implementation function.

Startup should report manifest tools without registry implementations. In test and
production modes this is fatal for enabled agents; development mode may expose a
clear unavailable-tool result.

## Bounded execution

The initial engine should orchestrate existing deterministic handlers, not create
an unrestricted autonomous loop.

Enforce:

- maximum run duration;
- maximum tool calls per run;
- maximum outbound messages per run;
- cancellation propagation;
- payload-size limits; and
- no recursive agent execution without an explicit bus message.

If a later model-driven loop is added, the same limits and tool boundary remain.

## OpenClaw option

If D1 selects real OpenClaw:

- implement `openclawAdapter.mjs` behind `runAgent()`;
- generate valid OpenClaw workspace/skill artifacts rather than the current
  `build/skills/<seat>.md` convention;
- register project tools through an OpenClaw plugin;
- enforce policies with tool allow/deny configuration plus a fail-closed
  `before_tool_call` hook;
- bind OpenClaw session identity to `runId`, seat, and client; and
- keep project A2A signing and durable transport outside conversational channels.

Do not rely on `SOUL.md`, `SKILL.md`, or prompt instructions for hard refusals.

## First vertical slice

Migrate this bounded path first:

```text
instruction_from_studio A2A
  -> l_amministrativo.handle_instruction
  -> guarded document lookup/request tools
  -> acknowledgment + typed result A2A
```

It exercises manifest loading, skills, guardrails, A2A input/output, and the bus
without touching the final AdE gate.

The second slice should execute `ade.prepare_only` and prove that any attempt to
resolve or invoke a transmit action is refused twice: by guardrails and connector.

## Tests

Create `tests/agentEngine.test.mjs` and runtime fixtures covering:

- valid run succeeds with a validated manifest;
- unknown seat and operation fail closed;
- unregistered or non-allowlisted tool is unavailable;
- run identity cannot be changed by handler input;
- timeout and cancellation stop further tool calls;
- tool-call and message-count limits are enforced;
- approval-required returns without executing the tool;
- denied action returns `refused` with a stable reason code;
- invalid artifact/outbound message is rejected;
- handler exception becomes a structured failure;
- correlated outbound messages carry the run correlation ID; and
- concurrent runs do not leak client or approval context.

## Completion criteria

- `runAgent()` is the only new entry point needed by HTTP, scheduler, and bus
  consumers.
- At least one existing flow uses the runtime end to end.
- No migrated handler imports raw side-effecting connectors.
- Every migrated tool call crosses guardrails and audit.
- The runtime works with the in-memory bus and the selected durable adapter.
- No OpenClaw-specific type leaks through the public runtime contract.
