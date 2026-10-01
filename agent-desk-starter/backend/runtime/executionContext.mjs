import { makeMessage } from "../../contracts/a2aSchema.mjs";
import { RuntimeApprovalRequiredError, RuntimeError, RuntimeRefusalError } from "./errors.mjs";

function parseWith(schema, value, code, label) {
  if (!schema) return value;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeError(code, `${label} failed validation.`);
  }
  return parsed.data;
}

function assertWithinBytes(value, maximum, code, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new RuntimeError(code, `${label} must be JSON-serializable.`);
  }
  const bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
  if (bytes > maximum) throw new RuntimeError(code, `${label} exceeds the ${maximum}-byte limit.`);
}

function throwIfStopped(active, signal) {
  if (!active()) throw new RuntimeError("RUN_CLOSED", "The agent run is no longer active.");
  if (signal.aborted) {
    if (signal.reason instanceof Error) throw signal.reason;
    throw new RuntimeError("RUN_CANCELLED", "The agent run was cancelled.", { retryable: true });
  }
}

export function createExecutionContext({
  request,
  manifest,
  operation,
  operationTools = null,
  toolRegistry,
  authorizer,
  audit,
  signal,
  limits,
  messageFactory = makeMessage,
}) {
  let isActive = true;
  let toolCalls = 0;
  const messages = [];
  const active = () => isActive;
  const identity = Object.freeze({
    runId: request.runId,
    seat: request.seat,
    clientId: request.context.clientId,
    correlationId: request.context.correlationId,
    causationId: request.context.causationId,
    actor: request.context.actor,
    operation,
  });

  async function invoke(toolId, rawArgs = {}, options = {}) {
    throwIfStopped(active, signal);
    if (operationTools && !operationTools.includes(toolId)) {
      throw new RuntimeRefusalError(
        "OPERATION_TOOL_NOT_DECLARED",
        `Operation "${operation}" may not invoke tool "${toolId}".`,
      );
    }
    toolCalls += 1;
    if (toolCalls > limits.maxToolCalls) {
      throw new RuntimeError("TOOL_CALL_LIMIT", `Run exceeded its ${limits.maxToolCalls}-tool-call limit.`);
    }

    const tool = toolRegistry.resolve(toolId);
    assertWithinBytes(rawArgs, limits.maxPayloadBytes, "TOOL_INPUT_TOO_LARGE", `Input for ${toolId}`);
    const args = parseWith(tool.inputSchema, rawArgs, "INVALID_TOOL_INPUT", `Input for ${toolId}`);
    const decision = await authorizer({
      run: identity,
      manifest,
      tool,
      args,
      approvalReceipt: options.approvalReceipt || null,
    });

    if (decision.outcome === "deny") {
      throw new RuntimeRefusalError(decision.code || "POLICY_DENIED", decision.reason || "Tool call denied.");
    }
    if (decision.outcome === "approval_required") {
      throw new RuntimeApprovalRequiredError(decision.approval);
    }
    if (decision.outcome !== "allow") {
      throw new RuntimeRefusalError("INVALID_POLICY_DECISION", "Guardrails did not return a valid allow decision.");
    }

    let output;
    try {
      output = await tool.execute(args, { ...identity, signal });
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      try { await audit.append({
        event: "tool.failed",
        runId: identity.runId,
        correlationId: identity.correlationId,
        seat: identity.seat,
        clientId: identity.clientId,
        toolId,
        action: tool.action,
        at: new Date().toISOString(),
      }); } catch { /* The authorization decision is the mandatory risk audit. */ }
      throw new RuntimeError("TOOL_EXECUTION_FAILED", `Tool "${toolId}" failed.`, { retryable: true });
    }

    throwIfStopped(active, signal);
    const parsedOutput = parseWith(tool.outputSchema, output, "INVALID_TOOL_OUTPUT", `Output from ${toolId}`);
    assertWithinBytes(parsedOutput, limits.maxPayloadBytes, "TOOL_OUTPUT_TOO_LARGE", `Output from ${toolId}`);
    try { await audit.append({
      event: "tool.completed",
      runId: identity.runId,
      correlationId: identity.correlationId,
      seat: identity.seat,
      clientId: identity.clientId,
      toolId,
      action: tool.action,
      at: new Date().toISOString(),
    }); } catch { /* Best-effort lifecycle record; authorization already succeeded. */ }
    return parsedOutput;
  }

  function emit(type, payload = {}, { to, causationId } = {}) {
    throwIfStopped(active, signal);
    if (messages.length >= limits.maxMessages) {
      throw new RuntimeError("MESSAGE_LIMIT", `Run exceeded its ${limits.maxMessages}-message limit.`);
    }
    if (!to || typeof to !== "string") throw new RuntimeError("INVALID_RECIPIENT", "Outbound message recipient is required.");

    const endpointAllowed = manifest.tools.includes(`a2a.endpoint:${to}`) || manifest.tools.includes(`a2a.handoff:${to}`);
    if (!endpointAllowed) {
      throw new RuntimeRefusalError("A2A_RECIPIENT_NOT_ALLOWED", `${manifest.seat} may not send A2A messages to "${to}".`);
    }

    assertWithinBytes(payload, limits.maxPayloadBytes, "MESSAGE_TOO_LARGE", "Outbound message");
    let message;
    try {
      message = messageFactory({
        ...payload,
        type,
        from: identity.seat,
        to,
        client: identity.clientId,
        correlationId: identity.correlationId,
        causationId: causationId || identity.causationId,
      });
    } catch {
      throw new RuntimeError("INVALID_OUTBOUND_MESSAGE", "Outbound A2A message failed validation.");
    }
    messages.push(message);
    return message;
  }

  return {
    context: Object.freeze({
      identity,
      manifest,
      signal,
      tools: Object.freeze({ invoke }),
      messages: Object.freeze({ emit }),
    }),
    close() { isActive = false; },
    getMessages() { return messages.slice(); },
    getToolCallCount() { return toolCalls; },
  };
}

export { assertWithinBytes };
