// backend/fixtures/clientDirectory.fixture.mjs
// -------------------------------------------------------------------
// Placeholder until there's a real client-config source (a TeamSystem
// client record, a settings screen, whatever the team decides). Swap
// the import in backend/clientDirectory.mjs when that lands — callers
// (lAmministrativo.mjs) don't change either way.
//
// These numbers are NOT real, reachable WhatsApp numbers. Do not point
// WHATSAPP_TOKEN/WHATSAPP_PHONE_ID at real credentials while these are
// still in use — a "live" send would either fail outright or, worse,
// succeed against whoever actually holds that number if it's ever
// reassigned. Replace every entry with a verified real number before
// this goes anywhere near production.
// -------------------------------------------------------------------

export const clientDirectoryFixture = [
  { clientId: "rossi_srl", ownerName: "Sig. Rossi", ownerPhone: "+390000000001" },
  { clientId: "bianchi_snc", ownerName: "Sig.ra Bianchi", ownerPhone: "+390000000002" },
];
