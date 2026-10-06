import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RuntimeRequestInputSchema, RuntimeRequestSchema, RuntimeResultSchema } from "../../contracts/runtimeSchema.mjs";
import { A2AMessageSchema, makeMessage } from "../../contracts/a2aSchema.mjs";
import { ManifestSchema } from "../../contracts/manifestSchema.mjs";
import { publishA2A } from "../messaging/a2aBus.mjs";
import { getActiveManifest } from "../compiler.mjs";
import { createGuardrails } from "./guardrails.mjs";
import { defaultApprovalStore } from "./approvalStore.mjs";
import { runtimeAudit } from "./audit.mjs";
import { createExecutionContext, assertWithinBytes } from "./executionContext.mjs";
import { defaultAgentRegistry, defaultToolRegistry } from "./defaultRegistry.mjs";
import { RuntimeError, RuntimeTimeoutError } from "./errors.mjs";

const HandlerResultSchema = z.object({
  artifacts: z.array(z.unknown()).default([]),
}).passthrough();

const DEFAULT_LIMITS = Object.freeze({
  maxRunMs: 30_000,
  maxToolCalls: 20,
  maxMessages: 20,
  maxPayloadBytes: 256 * 1024,
  maxArtifactBytes: 1024 * 1024,
});

function isoNow(clock) {
  return new Date(clock()).toISOString();
}

function normalizeRequest(raw, idGenerator) {
  const parsed = RuntimeRequestInputSchema.parse(raw);
  const runId = parsed.runId || idGenerator();
  return RuntimeRequestSchema.parse({
    ...parsed,
    runId,
    context: {
      ...parsed.context,
      correlationId: parsed.context.correlationId || runId,
    },
  });
}

function parseOrRuntimeError(schema, value, code, message) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RuntimeError(code, message);
  return parsed.data;
}

function publicError(error) {
  if (error instanceof RuntimeError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof z.ZodError) {
    return { code: "INVALID_RUNTIME_REQUEST", message: "The runtime request failed validation.", retryable: false };
  }
  return { code: "UNEXPECTED_RUNTIME_ERROR", message: "The agent run failed unexpectedly.", retryable: false };
}

function resultIdentity(raw, idGenerator) {
  const runId = typeof raw?.runId === "string" && raw.runId.length > 0 && raw.runId.length <= 160
    ? raw.runId
    : idGenerator();
  const seat = typeof raw?.seat === "string" && /^[a-z0-9_]+$/.test(raw.seat) ? raw.seat : "unknown";
  return { runId, seat };
}

function createController(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new RuntimeError("RUN_CANCELLED", "The agent run was cancelled.", { retryable: true }));
  if (externalSignal) {
    if (externalSignal.aborted) cancel();
    else externalSignal.addEventListener("abort", cancel, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new RuntimeTimeoutError()), timeoutMs);
  return {
    controller,
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", cancel);
    },
  };
}

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    const rejectForAbort = () => reject(signal.reason instanceof Error ? signal.reason : new RuntimeTimeoutError());
    if (signal.aborted) rejectForAbort();
    else signal.addEventListener("abort", rejectForAbort, { once: true });
  });
}

export function createAgentEngine({
  agentRegistry = defaultAgentRegistry,
  toolRegistry = defaultToolRegistry,
  loadManifest = getActiveManifest,
  authorizer = null,
  approvalStore = defaultApprovalStore,
  audit = runtimeAudit,
  publishMessage = (message) => publishA2A(message, { publisher: message.from }),
  messageFactory = makeMessage,
  clock = () => Date.now(),
  idGenerator = randomUUID,
  limits: configuredLimits = {},
} = {}) {
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...configuredLimits });
  const effectiveAuthorizer = authorizer || createGuardrails({ approvalStore, audit, clock, idGenerator });
  const appendRunAudit = async (record) => {
    try { await audit.append(record); } catch { /* Decision policy handles risk-specific audit failures. */ }
  };

  async function validateConfiguration({ strict = true, seats = agentRegistry.seats() } = {}) {
    const reports = [];
    for (const seat of seats) {
      let loaded;
      try {
        loaded = await loadManifest(seat);
      } catch {
        reports.push({ seat, missingTools: [], operationIssues: [], error: "MANIFEST_LOAD_FAILED" });
        continue;
      }
      const parsed = ManifestSchema.safeParse(loaded);
      if (!parsed.success || parsed.data.seat !== seat) {
        reports.push({ seat, missingTools: [], operationIssues: [], error: "INVALID_MANIFEST" });
        continue;
      }
      const missingTools = parsed.data.tools.filter((toolId) =>
        !toolId.startsWith("a2a.endpoint:") &&
        !toolId.startsWith("a2a.handoff:") &&
        !toolRegistry.has(toolId));
      const operationIssues = agentRegistry.operations(seat).flatMap((registeredOperation) =>
        (registeredOperation.tools || []).flatMap((toolId) => {
          if (!toolRegistry.has(toolId)) return [`${registeredOperation.name}:unregistered:${toolId}`];
          if (!parsed.data.tools.includes(toolId)) return [`${registeredOperation.name}:not_in_manifest:${toolId}`];
          return [];
        }));
      reports.push({ seat, missingTools, operationIssues, error: null });
    }
    const invalid = reports.filter((report) => report.error || report.missingTools.length || report.operationIssues?.length);
    if (strict && invalid.length) {
      throw new RuntimeError(
        "RUNTIME_CONFIGURATION_INVALID",
        `Runtime configuration is incomplete for: ${invalid.map((report) => report.seat).join(", ")}.`,
        { details: invalid },
      );
    }
    return Object.freeze({ ok: invalid.length === 0, reports });
  }

  async function runAgent(rawRequest, { signal: externalSignal } = {}) {
    const fallback = resultIdentity(rawRequest, idGenerator);
    const startedAt = isoNow(clock);
    let request;
    let execution;
    let controllerHandle;

    try {
      request = normalizeRequest(rawRequest, idGenerator);
      assertWithinBytes(request.input, limits.maxPayloadBytes, "INPUT_TOO_LARGE", "Agent input");
      const manifest = parseOrRuntimeError(
        ManifestSchema,
        await loadManifest(request.seat),
        "INVALID_MANIFEST",
        `The active manifest for "${request.seat}" failed validation.`,
      );
      if (manifest.seat !== request.seat) {
        throw new RuntimeError("MANIFEST_SEAT_MISMATCH", "The active manifest does not match the requested seat.");
      }
      const operation = agentRegistry.resolve(request.seat, request.operation);
      for (const toolId of operation.tools || []) {
        if (!toolRegistry.has(toolId) || !manifest.tools.includes(toolId)) {
          throw new RuntimeError(
            "RUNTIME_CONFIGURATION_INVALID",
            `Operation "${request.operation}" is not correctly configured for tool "${toolId}".`,
          );
        }
      }
      const input = operation.inputSchema
        ? parseOrRuntimeError(operation.inputSchema, request.input, "INVALID_AGENT_INPUT", "The operation input failed validation.")
        : request.input;

      const requestedMs = request.context.deadline ? Date.parse(request.context.deadline) - clock() : limits.maxRunMs;
      const timeoutMs = Math.min(limits.maxRunMs, requestedMs);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RuntimeTimeoutError("The requested deadline has already passed.");
      controllerHandle = createController(externalSignal, timeoutMs);

      await appendRunAudit({
        event: "run.started",
        runId: request.runId,
        correlationId: request.context.correlationId,
        seat: request.seat,
        operation: request.operation,
        operationTools: operation.tools,
        clientId: request.context.clientId,
        at: startedAt,
      });

      execution = createExecutionContext({
        request,
        manifest,
        operation: request.operation,
        operationTools: operation.tools,
        toolRegistry,
        authorizer: effectiveAuthorizer,
        audit,
        signal: controllerHandle.controller.signal,
        limits,
        messageFactory,
      });

      const handlerPromise = Promise.resolve().then(() => operation.handler(input, execution.context));
      const rawHandlerResult = await Promise.race([handlerPromise, waitForAbort(controllerHandle.controller.signal)]);
      const handlerResult = parseOrRuntimeError(
        HandlerResultSchema,
        rawHandlerResult || {},
        "INVALID_AGENT_OUTPUT",
        "The agent handler returned an invalid result.",
      );
      const validatedHandlerResult = operation.outputSchema
        ? parseOrRuntimeError(operation.outputSchema, handlerResult, "INVALID_AGENT_OUTPUT", "The agent handler returned an invalid result.")
        : handlerResult;

      for (const artifact of validatedHandlerResult.artifacts) {
        assertWithinBytes(artifact, limits.maxArtifactBytes, "ARTIFACT_TOO_LARGE", "Runtime artifact");
      }

      const messages = execution.getMessages().map((message) => A2AMessageSchema.parse(message));
      for (const message of messages) {
        try {
          await publishMessage(message);
        } catch {
          throw new RuntimeError("MESSAGE_PUBLISH_FAILED", "An outbound A2A message could not be published.", { retryable: true });
        }
      }

      execution.close();
      const finishedAt = isoNow(clock);
      const result = RuntimeResultSchema.parse({
        runId: request.runId,
        seat: request.seat,
        status: "completed",
        artifacts: validatedHandlerResult.artifacts,
        messages,
        approval: null,
        error: null,
        startedAt,
        finishedAt,
      });
      await appendRunAudit({
        event: "run.finished",
        runId: request.runId,
        correlationId: request.context.correlationId,
        seat: request.seat,
        operation: request.operation,
        clientId: request.context.clientId,
        status: result.status,
        at: finishedAt,
      });
      return result;
    } catch (error) {
      execution?.close();
      const identity = request || fallback;
      const status = error instanceof RuntimeError ? error.status : "failed";
      const finishedAt = isoNow(clock);
      const result = RuntimeResultSchema.parse({
        runId: identity.runId,
        seat: identity.seat,
        status,
        artifacts: [],
        // Messages are only a committed runtime output after every validation
        // step and publication succeeds. Generated-but-unpublished messages are
        // intentionally not returned as if they had been delivered.
        messages: [],
        approval: status === "awaiting_approval" ? error.approval || error.details : null,
        error: publicError(error),
        startedAt,
        finishedAt,
      });
      await appendRunAudit({
        event: "run.finished",
        runId: result.runId,
        correlationId: request?.context?.correlationId || result.runId,
        seat: result.seat,
        operation: request?.operation || rawRequest?.operation || null,
        clientId: request?.context?.clientId || rawRequest?.context?.clientId || null,
        status: result.status,
        code: result.error.code,
        at: finishedAt,
      });
      return result;
    } finally {
      controllerHandle?.dispose();
    }
  }

  return Object.freeze({ runAgent, validateConfiguration, limits, agentRegistry, toolRegistry });
}

export const defaultAgentEngine = createAgentEngine();
export const runAgent = defaultAgentEngine.runAgent;
