# Decisions and Tool Inventory

## Purpose

This is the Phase 0 working sheet. Resolve the three architecture decisions and
normalize the tool inventory before implementing the runtime.

Statuses used below:

- **registered**: typed implementation is present in the runtime registry;
- **adapter-ready**: an implementation exists; add schemas and a registry adapter;
- **partial**: related code exists but not behind the declared tool contract;
- **messaging capability**: implement through the A2A bus, not as a raw business
  connector;
- **missing**: no implementation was found in the current repository; and
- **policy-only**: deliberately must not become an executable tool.

## Decision record

### Runtime

- Status: decided and implemented.
- Decision: native `agentEngine.mjs`; optional OpenClaw adapter later only if a
  deployment requirement appears.
- Consequence if native: smallest change and reuse of the current model gateway.
- Consequence if OpenClaw: compiler output, plugin tools, workspaces, sessions, and
  deployment must be adapted to real OpenClaw contracts.
- Owner/sign-off: project lead.

### Durable transport

- Status: decided and implemented.
- Decision: Redis Streams, with one bounded stream per recipient, consumer
  groups, `XAUTOCLAIM` recovery, durable idempotency keys, and one dead-letter
  stream. The in-memory adapter implements the same contract for tests/offline.
- Consequence if Redis: implement per-recipient streams and consumer groups.
- Consequence if NATS: implement subjects and durable JetStream consumers.
- Owner/sign-off: deployment/project lead.

### Manifest gates

- Status: decided and implemented.
- Decision: structured object with approver, actions, and expiry, plus a
  fail-closed legacy normalizer during migration.
- Consequence: compiler prompts/seeds and runtime validation change together.
- Owner/sign-off: runtime and compiler owners.

## Tool inventory

### Chief of Staff

| Manifest tool | Current mapping | Status | Required work |
|---|---|---|---|
| `compiler.parse_job_to_manifest` | `compiler.parseJobToManifest()` | adapter-ready | Add input/output schemas and registry adapter |
| `compiler.emit_skill` | `compiler.emitSkill()` | adapter-ready | Define artifact path/format and prevent arbitrary writes |
| `roster.create_agent` | `rosterStore.addRosterEntry()` | adapter-ready | Add authorization and audit |
| `roster.modify_agent` | `rosterStore.updateRosterEntry()` | adapter-ready | Add authorization and audit |
| `roster.report_performance` | No implementation found | missing | Define data source or remove from manifest for this milestone |
| `a2a.handoff:it_expert` | `makeMessage()` + bus | messaging capability | Replace with typed `messages.emit()` capability |

### IT Expert

| Manifest tool | Current mapping | Status | Required work |
|---|---|---|---|
| `connector.scaffold` | No implementation found | missing | Define bounded artifact generator or remove from enabled runtime |
| `connector.test` | No implementation found | missing | Define safe connector test contract |
| `oauth.configure` | No implementation found | missing | Must be credential-owner gated; never pass secrets to model |
| `mcp.register_server` | No implementation found | missing | Define deployment/admin boundary and approval policy |
| `a2a.endpoint:chief_of_staff` | `makeMessage()` + bus | messaging capability | Replace with typed `messages.emit()` capability |

### L'Addetto IVA

| Manifest tool | Current mapping | Status | Required work |
|---|---|---|---|
| `teamsystem.read_vat_batch` | `teamSystem.readVatBatch()` | registered | Typed, client-bound studio-edge adapter |
| `ledger.prior_period_compare` | `teamSystem.readPriorPeriod()` | registered | Read-only, client-bound prior-period adapter |
| `batch.reassemble` | Deterministic runtime adapter | registered | Pure, typed batch reconstruction |
| `a2a.handoff:lo_smistatore` | `makeMessage()` + bus | messaging capability | Replace with typed `messages.emit()` capability |
| `ade.prepare_only` | `adePortal.prepareSubmission()` | registered | Authority-risk adapter; connector transmit block retained |

`adePortal.transmit()` is **policy-only denied behavior**, not a tool that should be
registered or exposed to an agent.

### Il Classificatore

| Manifest tool | Current mapping | Status | Required work |
|---|---|---|---|
| `fattureincloud.read_document` | `fattureInCloud.readInvoice()` | adapter-ready | Normalize naming and input/output schemas |
| `coa.lookup` | `teamSystem.readChartOfAccounts()` and classifier inputs | partial | Define a read-only lookup adapter scoped to client |
| `fattureincloud.post_line` | Closest implementation is `postInvoice()` | partial | Confirm intended operation; do not map silently if semantics differ |
| `a2a.handoff:l_archivista` | `makeMessage()` + bus | messaging capability | Replace with typed `messages.emit()` capability |

### L'Amministrativo

| Manifest tool | Current mapping | Status | Required work |
|---|---|---|---|
| `bankfeed.read` | `bankFeed.movements()` | registered/mock | Typed, client-bound client-side adapter |
| `sdi.inbox` | `readSdiInbox()` | registered/stub | Typed, client-bound client-side adapter |
| `fattureincloud.draft` | `draftInvoice()` | registered/stub | Client-bound write; manifest invoice gate applies |
| `whatsapp.owner_employees` | `whatsapp.sendTemplate()` | registered | Client-side external-send risk with document-request action |
| `a2a.endpoint:lo_smistatore` | `makeMessage()` + bus | messaging capability | Enforce recipient restriction in message capability |

### Lo Smistatore

| Manifest tool | Current mapping | Status | Required work |
|---|---|---|---|
| `a2a.endpoint:l_amministrativo` | `makeMessage()` + bus | messaging capability | Enforce typed messages and intended recipient |
| `board.create_task` | Routing/UI publication in `server.mjs` | partial | Decide whether this is domain persistence or UI telemetry |
| `escalation.ladder` | `startLadder()` | adapter-ready | Add lifecycle/cancellation schemas and audit |

### L'Archivista

| Manifest tool | Current mapping | Status | Required work |
|---|---|---|---|
| `cortex.evidence_store` | `evidenceStore.put()/all()` | adapter-ready | Split read/write tools and enforce memory layers/client scope |
| `cortex.knowledge_store` | `knowledgeStore.get()/upsert()/all()` | adapter-ready | Split read/write tools and enforce evidence rule |
| `rule.propose` | `archivista.proposeRule()` | adapter-ready | Require evidence ID and validate scope |
| `a2a.endpoint:lo_smistatore` | `makeMessage()` + bus | messaging capability | Replace with typed `messages.emit()` capability |

## Normalization decisions

Before writing the registry, agree on:

1. Whether A2A endpoints/handoffs remain manifest tool strings or become a
   dedicated `messaging` capability in `ManifestSchema`.
2. Whether tool names describe domain operations (`invoice.draft`) or connector
   implementations (`fattureincloud.draft`). Prefer domain names if connectors
   may change.
3. The difference between tool ID and policy action. For example,
   `whatsapp.owner_employees` is a tool while `external_send` is the action/risk.
4. Which tools are read-only, mutating, external-send, payment, authority, or
   credential-administration operations.
5. Which writes accept an idempotency key.
6. Which missing tools should be implemented now versus removed/disabled for the
   milestone.

## Phase 0 sign-off checklist

- [ ] Runtime decision approved.
- [ ] Transport decision approved.
- [ ] Structured gate format approved.
- [ ] Every tool has an owner and milestone status.
- [ ] Ambiguous `fattureincloud.post_line` semantics resolved.
- [ ] `batch.reassemble` owner/contract resolved.
- [ ] Missing IT Expert tools explicitly included or excluded.
- [ ] A2A messaging capability representation decided.
- [ ] Tool/action/risk naming convention frozen.
- [ ] Production key custodian and secret store identified.
