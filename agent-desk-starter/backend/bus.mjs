// Compatibility facade. Domain-critical A2A uses messaging/a2aBus.mjs;
// existing UI/demo call sites keep these synchronous telemetry wrappers until
// the Phase 5 cutover removes legacy `publish("a2a", ...)` producers.
export { publishUi, subscribeUi, uiHistory } from "./messaging/uiBus.mjs";
import { publishUi, subscribeUi, uiHistory } from "./messaging/uiBus.mjs";

export function publish(channel, event) { return publishUi(channel, event); }
export function subscribe(listener) { return subscribeUi(listener); }
export function history(options) { return uiHistory(options); }
