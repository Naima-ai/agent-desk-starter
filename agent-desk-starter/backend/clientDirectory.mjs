// backend/clientDirectory.mjs
// Resolves a client id to its owner's real contact phone number.
//
// >>> TODO (real): this is currently the ONLY thing standing between
//     wa.sendTemplate("owner", ...) and a working Meta API call. Before
//     WHATSAPP_TOKEN is ever set to a real value, every client that will
//     receive a WhatsApp message MUST have a real, verified entry in the
//     directory this resolves against — see backend/fixtures/clientDirectory.fixture.mjs.
import { validateClientDirectory } from "../contracts/clientDirectorySchema.mjs";
import { clientDirectoryFixture } from "./fixtures/clientDirectory.fixture.mjs";

const directory = validateClientDirectory(clientDirectoryFixture);

/**
 * getOwnerPhone(clientId) -> E.164 phone string
 *
 * Dev override: if WHATSAPP_TEST_RECIPIENT is set (in .env, which is
 * gitignored), EVERY client resolves to that one number. This exists because
 * Meta's test mode only allows sending to numbers added + verified in the
 * dashboard, and a real personal number must never be committed to the
 * fixture file. Leave it unset in production.
 *
 * Otherwise: never throws — an unknown client falls back to the literal
 * "owner" (the old behavior), which is harmless while whatsapp.mjs's LIVE
 * flag is false, but logs loudly so this can't fail silently once it isn't.
 * Matches the same "warn, don't crash the demo" style as the other
 * stub connectors (bankFeed.mock.mjs, sdiInbox.stub.mjs).
 */
export function getOwnerPhone(clientId, dir = directory) {
  if (process.env.WHATSAPP_TEST_RECIPIENT) return process.env.WHATSAPP_TEST_RECIPIENT;

  const entry = dir.find((d) => d.clientId === clientId);
  if (!entry) {
    console.warn(
      `[clientDirectory] no contact on file for "${clientId}" — WhatsApp calls for this client will fall back to the offline stub.`
    );
    return "owner";
  }
  return entry.ownerPhone;
}
