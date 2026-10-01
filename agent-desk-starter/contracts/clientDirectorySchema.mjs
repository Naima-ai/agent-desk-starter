// contracts/clientDirectorySchema.mjs
// -------------------------------------------------------------------
// THE CLIENT DIRECTORY CONTRACT — resolves a client id to a real,
// reachable contact. This exists because every wa.sendTemplate() call
// site in lAmministrativo.mjs was passing the literal string "owner"
// as the recipient, which only "worked" because WhatsApp falls back
// to an offline stub without a real token. The moment WHATSAPP_TOKEN
// is set for real, "owner" is not a valid WhatsApp recipient — Meta's
// Cloud API requires E.164 (+<countrycode><number>, digits only).
// -------------------------------------------------------------------
import { z } from "zod";

// + followed by 7–15 digits, first digit 1–9. Standard E.164 shape.
const E164 = /^\+[1-9]\d{6,14}$/;

export const ClientContactSchema = z.object({
  clientId: z.string(),
  ownerName: z.string(),
  ownerPhone: z.string().regex(E164, "must be E.164 format, e.g. +393401234567"),
});

export const ClientDirectorySchema = z.array(ClientContactSchema);

/** Throws a ZodError listing every problem; returns the typed directory. */
export function validateClientDirectory(obj) {
  return ClientDirectorySchema.parse(obj);
}
