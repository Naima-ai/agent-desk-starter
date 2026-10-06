# A2A Contract and Signing Plan

## Goal

Turn the existing nine message variants into a strict, versioned, authenticated
contract that can be safely accepted by a durable bus and correlated across an
agent workflow.

The business message types remain:

- `pack_delivered`;
- `document_delivered`;
- `item_missing`;
- `question_for_studio`;
- `instruction_from_studio`;
- `answer_with_evidence`;
- `escalation_requested`;
- `acknowledgment`; and
- `correction_request`.

Documentation that says eight types must be updated.

## Envelope v2

Keep `type` and the type-specific fields at the top level for a smaller migration
from the current UI and routing code.

```js
{
  schemaVersion: 2,
  id: "uuid-or-uuidv7",
  type,
  from,
  to,
  client,
  createdAt,
  expiresAt,          // optional for time-sensitive commands
  correlationId,
  causationId,        // optional parent message ID
  // type-specific fields
  signature: {
    algorithm: "Ed25519",
    keyId,
    value             // base64/base64url signature
  }
}
```

Use strict Zod objects. Unexpected fields must be rejected instead of silently
stripped.

## Field rules

- `schemaVersion`: literal `2` for the new producer.
- `id`: generated once before signing; never changed during retries.
- `from`/`to`: seat-ID syntax validated by schema and existence validated against
  the runtime roster/identity registry.
- `client`: non-empty client ID with a documented maximum length.
- timestamps: ISO-8601 with timezone and semantically valid dates.
- `correlationId`: stable for the full business workflow.
- `causationId`: ID of the message that directly caused this message.
- message text: bounded lengths to prevent accidental oversized events.
- numeric values: finite, non-negative where the domain requires it.

Do not hard-code the current seven seats into the Zod enum; new compiled seats
must remain possible. Validate seat existence and authorization at runtime.

## Signing model

Use Node's built-in Ed25519 support.

Signing steps:

1. Construct and strictly validate the unsigned message.
2. Canonicalize all signed fields, excluding `signature.value`.
3. Sign the canonical bytes using the sender's private key.
4. Attach algorithm, key ID, and encoded signature.
5. Strictly validate the complete signed envelope.

Verification steps:

1. Strictly parse the complete envelope.
2. Resolve the sender/key ID to a trusted public key.
3. Recreate the canonical unsigned bytes.
4. Verify the signature.
5. Validate timestamps, expiry, sender authorization, and recipient.
6. Check the replay store for the message ID.
7. Admit the message to the bus only after all checks succeed.

Select and document one deterministic canonical JSON implementation. Add golden
test vectors so another language can reproduce the same signed bytes.

## Key provider

Add a small interface rather than reading environment variables inside the
schema module:

```js
getSigningKey({ seat, keyId })
getVerificationKey({ seat, keyId })
getActiveKeyId({ seat })
```

Requirements:

- no private key in source, manifests, logs, or A2A messages;
- distinct sender identity/key association;
- key IDs support rotation;
- verification accepts an explicitly configured overlap window during rotation;
- unknown/revoked keys are rejected; and
- deterministic test keys live only under test fixtures.

## API changes

Replace the ambiguous signing stub with explicit operations:

```js
createUnsignedMessage(input, clockAndIds)
signMessage(unsignedMessage, signingKey)
verifyMessage(signedMessage, verificationKey)
makeMessage(input, dependencies) // convenience composition
```

Production code must not have a default key such as `"dev-key"`.

For tests and the offline demo, inject a clearly labeled development key provider.

## Compatibility and migration

1. Add v2 parsing/signing without changing consumers.
2. Update all `makeMessage()` producers to inject IDs, correlation, and keys.
3. Update consumers to read `createdAt` and `signature` rather than `ts`/`sig`.
4. Update frontend metadata/rendering as needed.
5. Permit v1 only behind an explicit development migration flag.
6. Remove v1 acceptance after all repository producers are migrated.

Never silently upgrade an unverified v1 network message into a trusted v2
message. Compatibility conversion is allowed only for trusted in-process legacy
callers during the migration window.

## Replay and idempotency

- The A2A envelope supplies a stable message ID.
- The bus records admitted IDs for at least the configured retention period.
- A duplicate with identical signed bytes is acknowledged as already admitted,
  not appended as a new logical message.
- The same ID with different bytes is treated as a security error.
- Consumer idempotency is separate and records completed `(consumer, messageId)`
  pairs.

## Tests

Create `tests/a2aSchema.test.mjs` with:

- valid round-trip for all nine message types;
- missing and additional fields rejected;
- wrong field types, invalid dates, and oversized text rejected;
- unique ID and supplied correlation ID behavior;
- signature verifies with the correct public key;
- payload/header tampering fails verification;
- wrong sender key, unknown key ID, and revoked key fail;
- expired messages fail;
- deterministic canonicalization golden vectors;
- duplicate same-ID/same-bytes classification;
- same-ID/different-bytes security rejection; and
- legacy v1 accepted only when the explicit migration mode is enabled.

## Completion criteria

- All nine variants use one strict v2 envelope.
- Every production message is signed with a sender-bound asymmetric key.
- No bus subscriber sees an invalid or unverified network message.
- Correlation and causation survive retries and agent handoffs.
- Key rotation can occur without accepting unknown keys.
- README and architecture documentation report nine message types.

