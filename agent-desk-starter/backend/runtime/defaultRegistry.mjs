import { z } from "zod";
import { prepareSubmission } from "../connectors/adePortal.mjs";
import { movements } from "../connectors/bankFeed.mock.mjs";
import { draftInvoice } from "../connectors/fattureInCloudDraft.stub.mjs";
import { readSdiInbox } from "../connectors/sdiInbox.stub.mjs";
import { readPriorPeriod, readVatBatch } from "../connectors/teamSystem.mjs";
import { sendTemplate } from "../connectors/whatsapp.mjs";
import { handleInstructionFromStudio } from "../lAmministrativo.mjs";
import { AgentRegistry } from "./agentRegistry.mjs";
import { ToolRegistry } from "./toolRegistry.mjs";

const BatchSchema = z.object({
  period: z.string().min(1),
  client: z.string().min(1),
  lines: z.array(z.unknown()),
}).passthrough();

const ClientReadInputSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(1).optional(),
}).strict();

const PriorPeriodSchema = z.object({
  period: z.string().nullable(),
  client: z.string().min(1),
  lines: z.array(z.unknown()),
}).passthrough();

const PrepareInputSchema = z.object({ batch: BatchSchema }).strict();
const PrepareOutputSchema = z.object({
  prepared: z.literal(true),
  period: z.string(),
  lines: z.number().int().nonnegative(),
  protocolDraft: z.string(),
  live: z.boolean(),
  note: z.string(),
}).strict();

const InstructionInputSchema = z.object({
  message: z.object({
    instruction: z.string().min(1),
    due: z.string().optional(),
  }).strict(),
}).strict();

const BankMovementSchema = z.object({
  date: z.string(),
  amount: z.number(),
  desc: z.string(),
}).passthrough();

const SdiDocumentSchema = z.object({
  supplier: z.string(),
  period: z.string(),
  sdiId: z.string(),
}).passthrough();

const WhatsAppInputSchema = z.object({
  clientId: z.string().min(1),
  to: z.string().min(1),
  template: z.string().min(1),
  vars: z.record(z.unknown()).default({}),
}).strict();

const DraftInvoiceInputSchema = z.object({
  clientId: z.string().min(1),
  invoiceData: z.record(z.unknown()),
}).strict();

const DraftInvoiceOutputSchema = z.object({
  draftId: z.string().min(1),
  clientId: z.string().min(1),
  status: z.literal("draft"),
}).passthrough();

export const defaultToolRegistry = new ToolRegistry()
  .register({
    id: "teamsystem.read_vat_batch",
    action: "read_vat_batch",
    risk: "read",
    inputSchema: ClientReadInputSchema,
    outputSchema: BatchSchema,
    clientScopePaths: ["clientId"],
    locations: ["studio_edge"],
    idempotent: true,
    execute: ({ clientId, period }) => readVatBatch(clientId, period),
  })
  .register({
    id: "ledger.prior_period_compare",
    action: "read_prior_period",
    risk: "read",
    inputSchema: z.object({ clientId: z.string().min(1) }).strict(),
    outputSchema: PriorPeriodSchema,
    clientScopePaths: ["clientId"],
    locations: ["studio_edge"],
    idempotent: true,
    execute: ({ clientId }) => readPriorPeriod(clientId),
  })
  .register({
    id: "batch.reassemble",
    action: "reassemble_batch",
    risk: "read",
    inputSchema: z.object({ batch: BatchSchema, additions: z.array(z.unknown()).default([]) }).strict(),
    outputSchema: BatchSchema,
    clientScopePaths: ["batch.client"],
    locations: ["studio_edge"],
    idempotent: true,
    execute: ({ batch, additions }) => ({ ...batch, lines: [...batch.lines, ...additions] }),
  })
  .register({
    id: "ade.prepare_only",
    action: "prepare_submission",
    risk: "authority",
    inputSchema: PrepareInputSchema,
    outputSchema: PrepareOutputSchema,
    clientScopePaths: ["batch.client"],
    locations: ["studio_edge"],
    idempotent: true,
    execute: ({ batch }) => prepareSubmission(batch),
  })
  .register({
    id: "bankfeed.read",
    action: "read_bankfeed",
    risk: "read",
    inputSchema: z.object({ clientId: z.string().min(1) }).strict(),
    outputSchema: z.array(BankMovementSchema),
    clientScopePaths: ["clientId"],
    locations: ["client_side"],
    idempotent: true,
    execute: () => movements(),
  })
  .register({
    id: "sdi.inbox",
    action: "read_sdi_inbox",
    risk: "read",
    inputSchema: z.object({ clientId: z.string().min(1) }).strict(),
    outputSchema: z.array(SdiDocumentSchema),
    clientScopePaths: ["clientId"],
    locations: ["client_side"],
    idempotent: true,
    execute: ({ clientId }) => readSdiInbox(clientId),
  })
  .register({
    id: "fattureincloud.draft",
    action: "invoice",
    risk: "write",
    inputSchema: DraftInvoiceInputSchema,
    outputSchema: DraftInvoiceOutputSchema,
    clientScopePaths: ["clientId"],
    locations: ["client_side"],
    idempotent: false,
    execute: ({ clientId, invoiceData }) => draftInvoice(clientId, invoiceData),
  })
  .register({
    id: "whatsapp.owner_employees",
    // Domain action and transport risk stay separate: the manifest gate names
    // generic external sends, while this constrained template requests a doc.
    action: "request_document",
    risk: "external_send",
    inputSchema: WhatsAppInputSchema,
    outputSchema: z.object({ ok: z.boolean() }).passthrough(),
    clientScopePaths: ["clientId"],
    locations: ["client_side"],
    idempotent: false,
    execute: ({ to, template, vars }) => sendTemplate(to, template, vars),
  });

export const defaultAgentRegistry = new AgentRegistry()
  .register({
    seat: "l_addetto_iva",
    operations: {
      prepare_submission: {
        inputSchema: PrepareInputSchema,
        tools: ["ade.prepare_only"],
        handler: async (input, ctx) => {
          const prepared = await ctx.tools.invoke("ade.prepare_only", input);
          return { artifacts: [prepared] };
        },
      },
    },
  })
  .register({
    seat: "l_amministrativo",
    operations: {
      handle_instruction: {
        inputSchema: InstructionInputSchema,
        tools: ["bankfeed.read", "sdi.inbox", "whatsapp.owner_employees"],
        handler: async (input, ctx) => {
          const result = await handleInstructionFromStudio(
            ctx.manifest,
            ctx.identity.clientId,
            input.message,
            {
              movements: () => ctx.tools.invoke("bankfeed.read", { clientId: ctx.identity.clientId }),
              readInbox: () => ctx.tools.invoke("sdi.inbox", { clientId: ctx.identity.clientId }),
              sendOwner: (template, vars) => ctx.tools.invoke("whatsapp.owner_employees", {
                clientId: ctx.identity.clientId, to: "owner", template, vars,
              }),
              toStudio: (message) => {
                const { type, ...payload } = message;
                return ctx.messages.emit(type, payload, { to: "lo_smistatore" });
              },
              scheduleLadder: false,
            },
          );
          const { ack, a2a, ...artifact } = result;
          return { artifacts: [artifact] };
        },
      },
    },
  });
