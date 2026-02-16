import { z } from "zod";
import type {
  MutationOperation,
  MutationRequest,
  MutationTargetInput,
  TargetSelectorInput,
  TransportName
} from "../domain/types.js";

const targetSchema = z
  .object({
    project_id: z.string().min(1).optional(),
    alias: z.string().min(1).optional()
  })
  .refine((target) => Boolean(target.project_id || target.alias), {
    message: "target requires project_id or alias"
  });

const operationSchema = z.object({
  operation_id: z.string().min(1),
  domain: z.enum(["project", "database", "auth", "function"]),
  action: z.enum([
    "project.create",
    "project.delete",
    "database.list",
    "database.create",
    "database.upsert_collection",
    "database.delete_collection",
    "auth.users.list",
    "auth.users.create",
    "auth.users.update.email",
    "auth.users.update.name",
    "auth.users.update.status",
    "auth.users.update.password",
    "auth.users.update.phone",
    "auth.users.update.email_verification",
    "auth.users.update.phone_verification",
    "auth.users.update.mfa",
    "auth.users.update.labels",
    "auth.users.update.prefs",
    "auth.users.update",
    "function.list",
    "function.create",
    "function.update",
    "function.deployment.trigger",
    "function.execution.trigger",
    "function.execution.status"
  ]),
  params: z.record(z.unknown()).default({}),
  required_scopes: z.array(z.string()).optional(),
  destructive: z.boolean().optional(),
  critical: z.boolean().optional(),
  idempotency_key: z.string().min(1).optional()
});

const targetSelectorSchema = z.object({
  mode: z.enum(["auto", "alias", "project_id"]).optional(),
  value: z.string().min(1).optional(),
  values: z.array(z.string().min(1)).optional()
});

const mutationSchemaBaseObject = z.object({
  actor: z.string().min(1),
  targets: z.array(targetSchema).optional(),
  target_selector: targetSelectorSchema.optional(),
  operations: z.array(operationSchema).min(1),
  transport: z.string().optional(),
  credentials: z.record(z.unknown()).optional()
});

const enforceTargetInput = (
  value: { targets?: Array<z.infer<typeof targetSchema>>; target_selector?: unknown },
  ctx: z.RefinementCtx
): void => {
  const hasTargets = (value.targets?.length ?? 0) > 0;
  const hasSelector = Boolean(value.target_selector);
  if (!hasTargets && !hasSelector) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "targets[] or target_selector is required",
      path: ["targets"]
    });
  }
};

const mutationSchemaBase = mutationSchemaBaseObject.superRefine(enforceTargetInput);

const previewSchema = mutationSchemaBase;

const applySchema = mutationSchemaBaseObject
  .extend({
  plan_id: z.string().min(1),
  plan_hash: z.string().min(1),
  confirmation_token: z.string().min(1).optional()
  })
  .superRefine(enforceTargetInput);

const issueConfirmationSchema = z.object({
  plan_hash: z.string().min(1),
  ttl_seconds: z.number().int().min(30).max(7200).optional()
});

const listCapabilitiesSchema = z
  .object({
    transport: z.string().optional()
  })
  .optional();

export type PreviewInput = z.infer<typeof previewSchema>;
export type ApplyInput = z.infer<typeof applySchema>;
export type IssueConfirmationInput = z.infer<typeof issueConfirmationSchema>;
export type ListCapabilitiesInput = z.infer<typeof listCapabilitiesSchema>;

const toTargetInput = (
  target: z.infer<typeof targetSchema>
): MutationTargetInput => ({
  project_id: target.project_id,
  alias: target.alias
});

const toOperationInput = (
  operation: z.infer<typeof operationSchema>
): MutationOperation => ({
  operation_id: operation.operation_id,
  domain: operation.domain,
  action: operation.action,
  params: operation.params,
  required_scopes: operation.required_scopes,
  destructive: operation.destructive,
  critical: operation.critical,
  idempotency_key: operation.idempotency_key
});

const toTargetSelectorInput = (
  selector: z.infer<typeof targetSelectorSchema> | undefined
): TargetSelectorInput | undefined => {
  if (!selector) {
    return undefined;
  }

  return {
    mode: selector.mode,
    value: selector.value,
    values: selector.values ? [...selector.values] : undefined
  };
};

export const parseListCapabilitiesInput = (
  rawInput: unknown
): { transport?: TransportName } => {
  const parsed = listCapabilitiesSchema.parse(rawInput);

  return {
    transport: parsed?.transport as TransportName | undefined
  };
};

export const parsePreviewRequest = (rawInput: unknown): MutationRequest => {
  const parsed = previewSchema.parse(rawInput);

  return {
    actor: parsed.actor,
    mode: "preview",
    targets: (parsed.targets ?? []).map((target: z.infer<typeof targetSchema>) =>
      toTargetInput(target)
    ),
    target_selector: toTargetSelectorInput(parsed.target_selector),
    operations: parsed.operations.map(
      (operation: z.infer<typeof operationSchema>) => toOperationInput(operation)
    ),
    transport: parsed.transport as TransportName | undefined,
    credentials: parsed.credentials
  };
};

export const parseApplyRequest = (
  rawInput: unknown
): MutationRequest & { confirmation_token?: string } => {
  const parsed = applySchema.parse(rawInput);

  return {
    actor: parsed.actor,
    mode: "apply",
    targets: (parsed.targets ?? []).map((target: z.infer<typeof targetSchema>) =>
      toTargetInput(target)
    ),
    target_selector: toTargetSelectorInput(parsed.target_selector),
    operations: parsed.operations.map(
      (operation: z.infer<typeof operationSchema>) => toOperationInput(operation)
    ),
    plan_id: parsed.plan_id,
    plan_hash: parsed.plan_hash,
    confirmation_token: parsed.confirmation_token,
    transport: parsed.transport as TransportName | undefined,
    credentials: parsed.credentials
  };
};

export const parseIssueConfirmationInput = (
  rawInput: unknown
): IssueConfirmationInput => issueConfirmationSchema.parse(rawInput);
