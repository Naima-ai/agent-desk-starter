const REFUSALS = Object.freeze({
  l_addetto_iva: Object.freeze(["transmit_to_authority", "sign_on_behalf_of_professional"]),
  l_amministrativo: Object.freeze(["tax_advice", "payments", "send_to_authority", "contact_studio_staff"]),
  lo_smistatore: Object.freeze(["answer_client_directly", "rank_people", "route_by_measured_behaviour"]),
  il_classificatore: Object.freeze(["post_below_confidence", "alter_chart_conventions", "invent_accounts"]),
  l_archivista: Object.freeze(["store_without_evidence", "auto_confirm_rule", "write_general_weights"]),
});

const GATES = Object.freeze({
  credential_change: Object.freeze({
    approver: "credential_owner",
    actions: Object.freeze(["credential_change"]),
    expiresInSeconds: 900,
  }),
  confirm_rule: Object.freeze({
    approver: "studio_professional",
    actions: Object.freeze(["confirm_rule"]),
    expiresInSeconds: 900,
  }),
});

export function systemRefusalsFor(seat) {
  return [...(REFUSALS[seat] || [])];
}

export function isSystemRefusal(seat, action) {
  return Boolean(REFUSALS[seat]?.includes(action));
}

export function systemGateFor(action) {
  return GATES[action] || null;
}

/** Synchronous compatibility boundary for legacy exported hard-block calls. */
export function assertStaticActionAllowed({ seat, action, manifest = null }) {
  if (isSystemRefusal(seat, action) || manifest?.refuses?.includes(action)) {
    throw new Error(`REFUSED: ${seat} will not perform "${action}" — hard block, not a suggestion.`);
  }
}
