// Compatibility facade. Domain-critical A2A uses messaging/a2aBus.mjs;
// `a2a` is deliberately rejected here after the Phase 5 cutover: domain
// messages must be persisted through messaging/a2aBus.mjs before they appear
// on the UI bridge.
export { publishUi, subscribeUi, uiHistory } from "./messaging/uiBus.mjs";
import { publishUi, subscribeUi, uiHistory } from "./messaging/uiBus.mjs";

export function publish(channel, event) {
  if (channel === "a2a") {
    throw new TypeError('A2A messages must use publishA2A(); the UI bus is telemetry-only.');
  }
  return publishUi(channel, event);
}
export function subscribe(listener) { return subscribeUi(listener); }
export function history(options) { return uiHistory(options); }
