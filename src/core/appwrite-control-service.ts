import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppwriteMcpError, toMutationErrorResponse } from "../domain/errors.js";
import type {
  ApplyResponse,
  AuthContext,
  CapabilityResponse,
  ConfirmationTokenResponse,
  ErrorResponse,
  MutationErrorResponse,
  MutationRequest,
  PlanRecord,
  PreviewResponse,
  RuntimeContextResponse,
  ScopeCatalogResponse,
  TargetExecutionResult,
  TargetSelectorInput,
  TargetsResolveResponse,
  TopLevelStatus,
  TransportName
} from "../domain/types.js";
import type { AppwriteAdapter } from "./appwrite-adapter.js";
import type { AuditLogger } from "./audit-log.js";
import { ConfirmationTokenService } from "./confirmation-token-service.js";
import { MutationExecutor } from "./mutation-executor.js";
import {
  parseApplyRequest,
  parseIssueConfirmationInput,
  parseListCapabilitiesInput,
  parsePreviewRequest
} from "./mutation-schemas.js";
import { PlanManager } from "./plan-manager.js";
import {
  scopeCatalog,
  withInferredRequiredScopes
} from "./operation-scope-catalog.js";
import { TargetResolver } from "./target-resolver.js";

interface AppwriteControlServiceOptions {
  adapter: AppwriteAdapter;
  auditLogger: AuditLogger;
  authContext: AuthContext;
  projectAuthContexts?: Record<string, AuthContext>;
  confirmationSecret: string;
  aliasMap?: Record<string, string>;
  knownProjectIds?: string[];
  autoTargetProjectIds?: string[];
  defaultTargetSelector?: TargetSelectorInput;
  transportDefault?: TransportName;
  supportedTransports?: TransportName[];
  requestedTransport?: TransportName;
  projectManagementAvailable?: boolean;
  now?: () => Date;
  randomId?: () => string;
  planTtlSeconds?: number;
}

export class AppwriteControlService {
  private readonly targetResolver: TargetResolver;
  private readonly confirmationTokenService: ConfirmationTokenService;
  private readonly planManager: PlanManager;
  private readonly mutationExecutor: MutationExecutor;
  private readonly transportDefault: TransportName;
  private readonly supportedTransports: TransportName[];
  private readonly requestedTransport?: TransportName;
  private readonly projectManagementAvailable: boolean;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly authContext: AuthContext;
  private readonly projectAuthContexts: Record<string, AuthContext>;
  private readonly knownProjectIds: string[];
  private readonly auditLogger: AuditLogger;

  constructor(options: AppwriteControlServiceOptions) {
    const knownProjectIds = options.knownProjectIds ?? Object.keys(options.projectAuthContexts ?? {});
    this.targetResolver = new TargetResolver({
      aliasMap: options.aliasMap ?? {},
      knownProjectIds,
      autoTargetProjectIds: options.autoTargetProjectIds,
      defaultTargetSelector: options.defaultTargetSelector
    });
    this.confirmationTokenService = new ConfirmationTokenService(
      options.confirmationSecret
    );
    this.transportDefault = options.transportDefault ?? "stdio";
    this.supportedTransports = options.supportedTransports ?? ["stdio"];
    this.requestedTransport = options.requestedTransport;
    this.projectManagementAvailable = options.projectManagementAvailable ?? false;
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => randomUUID());
    this.authContext = options.authContext;
    this.projectAuthContexts = { ...(options.projectAuthContexts ?? {}) };
    this.knownProjectIds = [...knownProjectIds];
    this.auditLogger = options.auditLogger;

    this.planManager = new PlanManager({
      now: this.now,
      randomId: this.randomId,
      planTtlSeconds: options.planTtlSeconds ?? 900
    });

    this.mutationExecutor = new MutationExecutor({
      adapter: options.adapter,
      auditLogger: options.auditLogger,
      projectManagementAvailable: this.projectManagementAvailable,
      now: this.now
    });
  }

  getAuditRecords() {
    return this.auditLogger.list();
  }

  listCapabilities(rawInput?: unknown): CapabilityResponse | ErrorResponse {
    const correlationId = this.createCorrelationId();

    try {
      const parsed = parseListCapabilitiesInput(rawInput);
      this.resolveTransport(parsed.transport);

      return {
        correlation_id: correlationId,
        status: "SUCCESS",
        capabilities: {
          domains: {
            project: {
              enabled: this.projectManagementAvailable,
              reason: this.projectManagementAvailable
                ? undefined
                : "project management channel is not configured"
            },
            database: { enabled: true },
            auth: { enabled: true },
            function: { enabled: true },
            operation: { enabled: true }
          },
          transport_default: this.transportDefault,
          supported_transports: [...this.supportedTransports],
          auto_targeting_enabled: true,
          scope_catalog_version: scopeCatalog.version
        },
        summary: `domains=5, default transport=${this.transportDefault}`
      };
    } catch (error) {
      const mapped = this.mapError(
        error,
        "preview",
        correlationId,
        "capabilities"
      );

      return {
        correlation_id: mapped.correlation_id,
        status: mapped.status,
        summary: mapped.summary,
        error: mapped.error
      };
    }
  }

  preview(rawInput: unknown): PreviewResponse | MutationErrorResponse {
    const correlationId = this.createCorrelationId();

    try {
      const request = parsePreviewRequest(rawInput);
      this.resolveTransport(request.transport);

      const resolved = this.targetResolver.resolveRequest({
        targets: request.targets,
        targetSelector: request.target_selector
      });
      const normalizedRequest = this.normalizeRequestOperations(request);
      const plan = this.planManager.buildAndStorePlan(
        normalizedRequest,
        resolved.resolvedTargets
      );

      this.logPlanPreview(plan, normalizedRequest.actor, correlationId);

      return {
        correlation_id: correlationId,
        mode: "preview",
        status: "SUCCESS",
        plan_id: plan.plan_id,
        plan_hash: plan.plan_hash,
        target_projects: [...plan.target_projects],
        operations: [...plan.operations],
        destructive_count: plan.destructive_count,
        risk_level: plan.risk_level,
        required_scopes: [...plan.required_scopes],
        summary: `${this.buildPreviewSummary(
          plan.target_projects.length,
          plan.destructive_count,
          plan.risk_level
        )}, source=${resolved.source}`
      };
    } catch (error) {
      return this.mapError(error, "preview", correlationId);
    }
  }

  async apply(rawInput: unknown): Promise<ApplyResponse | MutationErrorResponse> {
    const correlationId = this.createCorrelationId();

    try {
      const request = parseApplyRequest(rawInput);
      this.resolveTransport(request.transport);

      const resolved = this.targetResolver.resolveRequest({
        targets: request.targets,
        targetSelector: request.target_selector
      });
      const normalizedRequest = this.normalizeRequestOperations(request);
      const plan = this.planManager.requireMatchingPlan(
        normalizedRequest,
        resolved.resolvedTargets
      );

      if (!this.hasPerProjectAuthContexts()) {
        this.ensureAuthContext(this.authContext);
        this.preflightScopes(plan.required_scopes, this.authContext.scopes);
      }

      this.enforceDestructivePolicy(plan, request.confirmation_token);

      const targetResults = await this.mutationExecutor.execute(
        normalizedRequest,
        resolved.resolvedTargets,
        plan,
        correlationId,
        (targetProjectId) => this.resolveAuthContextForTarget(targetProjectId)
      );

      const status = this.toTopLevelStatus(targetResults);
      return {
        correlation_id: correlationId,
        mode: "apply",
        status,
        plan_id: plan.plan_id,
        plan_hash: plan.plan_hash,
        target_results: targetResults,
        destructive_count: plan.destructive_count,
        risk_level: plan.risk_level,
        summary: `${this.buildApplySummary(
          targetResults,
          plan.destructive_count,
          plan.risk_level,
          status
        )}, source=${resolved.source}`
      };
    } catch (error) {
      return this.mapError(error, "apply", correlationId);
    }
  }

  issueConfirmationToken(
    rawInput: unknown
  ): ConfirmationTokenResponse | ErrorResponse {
    const correlationId = this.createCorrelationId();

    try {
      const parsed = parseIssueConfirmationInput(rawInput);
      const expiresAtDate = new Date(
        this.now().getTime() + (parsed.ttl_seconds ?? 300) * 1000
      );
      const expiresAtUnixSeconds = Math.floor(expiresAtDate.getTime() / 1000);
      const token = this.confirmationTokenService.issue(
        parsed.plan_hash,
        expiresAtUnixSeconds
      );

      return {
        correlation_id: correlationId,
        status: "SUCCESS",
        token,
        expires_at: expiresAtDate.toISOString(),
        summary: "confirmation token issued"
      };
    } catch (error) {
      const mapped = this.mapError(error, "preview", correlationId, "confirm");

      return {
        correlation_id: mapped.correlation_id,
        status: mapped.status,
        summary: mapped.summary,
        error: mapped.error
      };
    }
  }

  getRuntimeContext(): RuntimeContextResponse {
    const correlationId = this.createCorrelationId();
    const knownProjectIds = [...this.knownProjectIds];
    const aliases = this.targetResolverAliases();

    return {
      correlation_id: correlationId,
      status: "SUCCESS",
      context: {
        known_project_ids: knownProjectIds,
        alias_count: aliases,
        auto_target_project_ids: this.targetResolverAutoProjectIds(),
        default_target_selector: {
          mode: "auto"
        }
      },
      summary: `known_projects=${knownProjectIds.length}, aliases=${aliases}`
    };
  }

  resolveTargets(rawInput: unknown): TargetsResolveResponse | ErrorResponse {
    const correlationId = this.createCorrelationId();

    try {
      const request = parsePreviewRequest({
        actor: "targets-resolver",
        operations: [
          {
            operation_id: "op-resolve",
            domain: "auth",
            action: "auth.users.list",
            params: {}
          }
        ],
        ...((rawInput && typeof rawInput === "object")
          ? (rawInput as Record<string, unknown>)
          : {})
      });

      const resolved = this.targetResolver.resolveRequest({
        targets: request.targets,
        targetSelector: request.target_selector
      });

      return {
        correlation_id: correlationId,
        status: "SUCCESS",
        resolved_targets: resolved.resolvedTargets.map((target) => target.project_id),
        source: resolved.source,
        summary: `resolved=${resolved.resolvedTargets.length}`
      };
    } catch (error) {
      const mapped = this.mapError(error, "preview", correlationId, "targets");
      return {
        correlation_id: mapped.correlation_id,
        status: mapped.status,
        summary: mapped.summary,
        error: mapped.error
      };
    }
  }

  getScopeCatalog(): ScopeCatalogResponse {
    const correlationId = this.createCorrelationId();

    return {
      correlation_id: correlationId,
      status: "SUCCESS",
      catalog_version: scopeCatalog.version,
      actions: Object.fromEntries(
        Object.entries(scopeCatalog.actions).map(([action, requiredScopes]) => [
          action,
          { required_scopes: [...requiredScopes] }
        ])
      ) as ScopeCatalogResponse["actions"],
      summary: `actions=${Object.keys(scopeCatalog.actions).length}`
    };
  }

  private resolveTransport(override?: TransportName): TransportName {
    const candidate = override ?? this.requestedTransport ?? this.transportDefault;

    if (!this.supportedTransports.includes(candidate)) {
      throw new AppwriteMcpError(
        "CAPABILITY_UNAVAILABLE",
        `Unsupported transport: ${candidate}`,
        {
          target: "transport",
          operation_id: "*",
          supported_transports: this.supportedTransports,
          remediation: "Use one of supported_transports and retry"
        }
      );
    }

    return candidate;
  }

  private enforceDestructivePolicy(
    plan: PlanRecord,
    confirmationToken: string | undefined
  ): void {
    const hasCriticalOperation = plan.operations.some((operation) => operation.critical);

    if (!hasCriticalOperation) {
      return;
    }

    if (!confirmationToken) {
      throw new AppwriteMcpError(
        "CONFIRM_REQUIRED",
        "critical destructive operation requires confirmation token",
        {
          target: "confirmation",
          operation_id: "*"
        }
      );
    }

    const verification = this.confirmationTokenService.verify(
      confirmationToken,
      plan.plan_hash,
      Math.floor(this.now().getTime() / 1000)
    );

    if (verification.ok) {
      return;
    }

    if (verification.reason === "expired") {
      throw new AppwriteMcpError("CONFIRM_REQUIRED", "confirmation token expired", {
        target: "confirmation",
        operation_id: "*"
      });
    }

    throw new AppwriteMcpError("INVALID_CONFIRM_TOKEN", "invalid confirmation token", {
      target: "confirmation",
      operation_id: "*"
    });
  }

  private toTopLevelStatus(results: TargetExecutionResult[]): TopLevelStatus {
    const successCount = results.filter((entry) => entry.status === "SUCCESS").length;
    const failureCount = results.length - successCount;

    if (successCount > 0 && failureCount > 0) {
      return "PARTIAL_SUCCESS";
    }

    if (failureCount > 0) {
      return "FAILED";
    }

    return "SUCCESS";
  }

  private buildPreviewSummary(
    targetCount: number,
    destructiveCount: number,
    riskLevel: PlanRecord["risk_level"]
  ): string {
    return `targets=${targetCount}, destructive=${destructiveCount}, impact=${riskLevel}`;
  }

  private buildApplySummary(
    targetResults: TargetExecutionResult[],
    destructiveCount: number,
    riskLevel: PlanRecord["risk_level"],
    status: TopLevelStatus
  ): string {
    const successTargets = targetResults.filter(
      (result) => result.status === "SUCCESS"
    ).length;

    return `status=${status}, success_targets=${successTargets}/${targetResults.length}, destructive=${destructiveCount}, impact=${riskLevel}`;
  }

  private logPlanPreview(
    plan: PlanRecord,
    actor: string,
    correlationId: string
  ): void {
    for (const targetProject of plan.target_projects) {
      for (const operation of plan.operations) {
        this.auditLogger.append({
          actor,
          timestamp: this.now().toISOString(),
          target_project: targetProject,
          operation_id: operation.operation_id,
          outcome: "planned",
          correlation_id: correlationId,
          details: {
            destructive: operation.destructive,
            critical: operation.critical
          }
        });
      }
    }
  }

  private mapError(
    error: unknown,
    mode: "preview" | "apply",
    correlationId: string,
    fallbackTarget = "global"
  ): MutationErrorResponse {
    if (error instanceof AppwriteMcpError) {
      return toMutationErrorResponse(mode, correlationId, error);
    }

    if (error instanceof z.ZodError) {
      return toMutationErrorResponse(
        mode,
        correlationId,
        new AppwriteMcpError(
          "VALIDATION_ERROR",
          error.issues[0]?.message ?? "invalid input",
          {
            target: fallbackTarget,
            operation_id: "*"
          }
        )
      );
    }

    return toMutationErrorResponse(
      mode,
      correlationId,
      new AppwriteMcpError("INTERNAL_ERROR", "unexpected internal error", {
        target: fallbackTarget,
        operation_id: "*",
        retryable: true
      })
    );
  }

  private createCorrelationId(): string {
    return `corr_${this.randomId()}`;
  }

  private resolveAuthContextForTarget(
    targetProjectId: string
  ): AuthContext | AppwriteMcpError {
    const hasPerProjectContexts = this.hasPerProjectAuthContexts();
    if (hasPerProjectContexts) {
      const context = this.projectAuthContexts[targetProjectId];
      if (!context) {
        return new AppwriteMcpError(
          "AUTH_CONTEXT_REQUIRED",
          "project auth context is missing",
          {
            target: targetProjectId,
            operation_id: "*",
            remediation:
              "Add this project_id entry to APPWRITE_PROJECT_AUTH_FILE and retry"
          }
        );
      }

      return {
        endpoint: context.endpoint,
        api_key: context.api_key,
        scopes: [...context.scopes]
      };
    }

    return {
      endpoint: this.authContext.endpoint,
      api_key: this.authContext.api_key,
      scopes: [...this.authContext.scopes]
    };
  }

  private hasPerProjectAuthContexts(): boolean {
    return Object.keys(this.projectAuthContexts).length > 0;
  }

  private ensureAuthContext(authContext: AuthContext): void {
    if (authContext.endpoint && authContext.api_key) {
      return;
    }

    throw new AppwriteMcpError(
      "AUTH_CONTEXT_REQUIRED",
      "stdio mode requires auth context from environment",
      {
        target: "auth_context",
        operation_id: "*",
        remediation:
          "Set APPWRITE_PROJECT_AUTH_FILE (or legacy endpoint/api key env) and retry"
      }
    );
  }

  private preflightScopes(requiredScopes: string[], availableScopes: string[]): void {
    const missingScopes = requiredScopes.filter(
      (scope) => !availableScopes.includes(scope)
    );

    if (missingScopes.length === 0) {
      return;
    }

    throw new AppwriteMcpError("MISSING_SCOPE", "required scopes are missing", {
      target: "scope",
      operation_id: "*",
      missing_scopes: missingScopes,
      remediation: "Issue an API key with all required_scopes"
    });
  }

  private normalizeRequestOperations(request: MutationRequest): MutationRequest {
    return {
      ...request,
      operations: withInferredRequiredScopes(request.operations)
    };
  }

  private targetResolverAliases(): number {
    return this.targetResolver.getAliasCount();
  }

  private targetResolverAutoProjectIds(): string[] {
    return this.targetResolver.getAutoTargetProjectIds();
  }
}
