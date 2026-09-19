// backend/connectors/fattureInCloudDraft.stub.mjs
// STUB connector. Client-side FiC draft creation — distinct from the studio's read/post in connectors/fattureInCloud.mjs. 
// Drafts only: sending an invoice always waits on the owner-approval gate in lAmministrativo.mjs, never here.
// >>> TODO (real): FiC API v2 draft-invoice endpoint, OAuth2 scoped to this client.
export async function draftInvoice(clientId, invoiceData) {
  console.warn(`[FiC-draft] stub — no real draft API wired for ${clientId}`);
  return { draftId: `DRAFT-${Date.now()}`, clientId, ...invoiceData, status: "draft" };
}
