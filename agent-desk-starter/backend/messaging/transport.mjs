export class TransportError extends Error {
  constructor(code, message, { retryable = true } = {}) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function assertTransport(transport) {
  const required = ["connect", "close", "health", "publish", "consume", "ack", "nack", "recover", "deadLetter"];
  for (const method of required) {
    if (typeof transport?.[method] !== "function") throw new TypeError(`A2A transport must implement ${method}().`);
  }
  return transport;
}

