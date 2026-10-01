# A2A Operations Runbook

## Health

Set `A2A_TRANSPORT=redis` and `REDIS_URL`, then check:

```bash
curl -sS http://127.0.0.1:5173/api/a2a-health
```

`connected`, `publishReady`, and `consumeReady` must be true. Investigate a
growing `pending`, `oldestPendingAgeMs`, or `deadLetters` value before replaying
work. The normal recovery loop claims abandoned Redis deliveries automatically.

## Dead letters

List redacted metadata; the HTTP response never includes the signed payload:

```bash
curl -sS http://127.0.0.1:5173/api/a2a-dead-letters
```

Fix the reported consumer/configuration failure first. Configure a strong
`A2A_OPERATOR_TOKEN`, then replay exactly one entry by its dead-letter ID:

```bash
curl -X POST \
  -H "Authorization: Bearer $A2A_OPERATOR_TOKEN" \
  http://127.0.0.1:5173/api/a2a-dead-letters/ENTRY_ID/replay
```

Replay preserves the original message ID. Consumer completion idempotency keeps
an already-completed action from running twice. Do not replay malformed,
tampered, unauthorized, or expired messages; they will fail verification again.

## Restart and shutdown

SIGINT/SIGTERM first stops HTTP intake, then unsubscribes runtime consumers, and
finally closes the transport. Redis pending entries survive an interrupted
process and are reclaimed after `A2A_CLAIM_IDLE_MS`.

Run the broker-backed recovery contract before deployment:

```bash
REDIS_URL=redis://127.0.0.1:6379 npm run test:redis
```

## Signing keys

The current repository signature is explicitly development-only. Do not expose
the A2A ingress to an untrusted network until the Phase 1 Ed25519 key-provider,
rotation, expiry, and revocation work is complete. Never put private keys in
manifests, source, logs, or A2A messages.

## Approvals

Pending runtime approvals are visible at `GET /api/gates`. An approval must use
the required role and is bound to the exact run, client, tool, action, and input
hash. Resume by rerunning the same operation with the same run ID and input.
