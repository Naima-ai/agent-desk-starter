// backend/connectors/sdiInbox.stub.mjs
// STUB connector.
// >>> TODO (real): poll or webhook the client's SDI inbox
// (Sistema di Interscambio) for received electronic invoices.
// Keep the return shape stable — [{ supplier, period, sdiId }] — so backend/lAmministrativo.mjs needs no changes when this goes live.
export async function readSdiInbox(clientId) {
  console.warn(`[SDI] stub — no real inbox wired for ${clientId}`);
  return [];
}
