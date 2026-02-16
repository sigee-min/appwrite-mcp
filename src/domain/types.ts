export type MutationMode = "preview" | "apply";

export type CapabilityDomain =
  | "project"
  | "database"
  | "auth"
  | "function"
  | "operation";

export type OperationDomain = "project" | "database" | "auth" | "function";

export type OperationAction =
  | "project.create"
  | "project.delete"
  | "database.list"
  | "database.create"
  | "database.upsert_collection"
  | "database.delete_collection"
  | "auth.users.list"
  | "auth.users.create"
  | "auth.users.update.email"
  | "auth.users.update.name"
  | "auth.users.update.status"
  | "auth.users.update.password"
  | "auth.users.update.phone"
  | "auth.users.update.email_verification"
  | "auth.users.update.phone_verification"
  | "auth.users.update.mfa"
  | "auth.users.update.labels"
  | "auth.users.update.prefs"
  | "auth.users.update"
  | "function.list"
  | "function.create"
  | "function.update"
  | "function.deployment.trigger"
  | "function.execution.trigger"
  | "function.execution.status";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export type TopLevelStatus = "SUCCESS" | "PARTIAL_SUCCESS" | "FAILED";

export type TargetOperationStatus = "SUCCESS" | "FAILED";

export type AuditOutcome = "planned" | "success" | "failed" | "skipped";

export type TransportName = "stdio" | "streamable-http" | (string & {});

export type TargetSelectorMode = "auto" | "alias" | "project_id";

export type ErrorCode =
  | "PLAN_MISMATCH"
  | "TARGET_NOT_FOUND"
  | "TARGET_AMBIGUOUS"
  | "CAPABILITY_UNAVAILABLE"
  | "CONFIRM_REQUIRED"
  | "INVALID_CONFIRM_TOKEN"
  | "MISSING_SCOPE"
  | "AUTH_CONTEXT_REQUIRED"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR";

export interface CapabilityState {
  enabled: boolean;
  reason?: string;
}

export type DomainCapabilityMap = Record<CapabilityDomain, CapabilityState>;

export interface RuntimeCapabilities {
  domains: DomainCapabilityMap;
  transport_default: TransportName;
  supported_transports: TransportName[];
  auto_targeting_enabled?: boolean;
  scope_catalog_version?: string;
}

export interface TargetSelectorInput {
  mode?: TargetSelectorMode;
  value?: string;
  values?: string[];
}

export interface MutationTargetInput {
  project_id?: string;
  alias?: string;
}

export interface ResolvedTarget {
  index: number;
  source: MutationTargetInput;
  project_id: string;
}

export interface MutationOperation {
  operation_id: string;
  domain: OperationDomain;
  action: OperationAction;
  params: Record<string, unknown>;
  required_scopes?: string[];
  destructive?: boolean;
  critical?: boolean;
  idempotency_key?: string;
}

export interface MutationRequest {
  actor: string;
  mode: MutationMode;
  targets: MutationTargetInput[];
  target_selector?: TargetSelectorInput;
  operations: MutationOperation[];
  plan_id?: string;
  plan_hash?: string;
  confirmation_token?: string;
  transport?: TransportName;
  credentials?: Record<string, unknown>;
}

export interface PlanOperationDescriptor {
  operation_id: string;
  domain: OperationDomain;
  action: OperationAction;
  destructive: boolean;
  critical: boolean;
}

export interface PlanRecord {
  plan_id: string;
  plan_hash: string;
  actor: string;
  target_projects: string[];
  operations: PlanOperationDescriptor[];
  required_scopes: string[];
  destructive_count: number;
  risk_level: RiskLevel;
  created_at: string;
  expires_at: string;
}

export interface StandardError {
  code: ErrorCode;
  message: string;
  target: string;
  operation_id: string;
  retryable: boolean;
  missing_scopes?: string[];
  supported_transports?: TransportName[];
  remediation?: string;
}

export interface ErrorResponse {
  correlation_id: string;
  status: "FAILED";
  summary: string;
  error: StandardError;
}

export interface MutationErrorResponse extends ErrorResponse {
  mode: MutationMode;
}

export interface PreviewResponse {
  correlation_id: string;
  mode: "preview";
  status: "SUCCESS";
  plan_id: string;
  plan_hash: string;
  target_projects: string[];
  operations: PlanOperationDescriptor[];
  destructive_count: number;
  risk_level: RiskLevel;
  required_scopes: string[];
  summary: string;
}

export interface TargetOperationResult {
  operation_id: string;
  status: TargetOperationStatus;
  data?: Record<string, unknown>;
  error?: StandardError;
}

export interface TargetExecutionResult {
  target: MutationTargetInput;
  project_id: string;
  status: TargetOperationStatus;
  operations: TargetOperationResult[];
}

export interface ApplyResponse {
  correlation_id: string;
  mode: "apply";
  status: TopLevelStatus;
  plan_id: string;
  plan_hash: string;
  target_results: TargetExecutionResult[];
  destructive_count: number;
  risk_level: RiskLevel;
  summary: string;
}

export interface CapabilityResponse {
  correlation_id: string;
  status: "SUCCESS";
  capabilities: RuntimeCapabilities;
  summary: string;
}

export interface RuntimeContextResponse {
  correlation_id: string;
  status: "SUCCESS";
  context: {
    known_project_ids: string[];
    alias_count: number;
    auto_target_project_ids: string[];
    default_target_selector: TargetSelectorInput;
  };
  summary: string;
}

export interface TargetsResolveResponse {
  correlation_id: string;
  status: "SUCCESS";
  resolved_targets: string[];
  source: "explicit" | "selector" | "auto";
  summary: string;
}

export interface ScopeCatalogResponse {
  correlation_id: string;
  status: "SUCCESS";
  catalog_version: string;
  actions: Record<OperationAction, { required_scopes: string[] }>;
  summary: string;
}

export interface ConfirmationTokenResponse {
  correlation_id: string;
  status: "SUCCESS";
  token: string;
  expires_at: string;
  summary: string;
}

export interface AuthContext {
  endpoint?: string;
  api_key?: string;
  scopes: string[];
}

export interface ProjectAuthEntry {
  api_key: string;
  scopes?: string[];
  endpoint?: string;
  aliases?: string[];
  default_for_auto?: boolean;
  display_name?: string;
}

export interface ProjectAuthFile {
  default_endpoint: string;
  projects: Record<string, ProjectAuthEntry>;
  management?: {
    endpoint?: string;
    api_key: string;
    scopes?: string[];
    project_id?: string;
  };
  defaults?: {
    auto_target_project_ids?: string[];
    target_selector?: TargetSelectorInput;
  };
}

export interface AuditRecord {
  actor: string;
  timestamp: string;
  target_project: string;
  operation_id: string;
  outcome: AuditOutcome;
  correlation_id: string;
  details?: Record<string, unknown>;
}
