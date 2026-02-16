import { AppwriteMcpError, toStandardError } from "../domain/errors.js";
import { redactSecrets } from "../domain/redaction.js";
import type {
  AuditRecord,
  AuthContext,
  MutationOperation,
  MutationRequest,
  PlanRecord,
  ResolvedTarget,
  StandardError,
  TargetExecutionResult,
  TargetOperationResult
} from "../domain/types.js";
import type { AppwriteAdapter } from "./appwrite-adapter.js";
import type { AuditLogger } from "./audit-log.js";
import { IdempotencyRegistry } from "./idempotency-registry.js";

interface MutationExecutorOptions {
  adapter: AppwriteAdapter;
  auditLogger: AuditLogger;
  projectManagementAvailable: boolean;
  managementAuthContext?: AuthContext;
  now: () => Date;
}

export class MutationExecutor {
  private readonly idempotencyRegistry = new IdempotencyRegistry();

  constructor(private readonly options: MutationExecutorOptions) {}

  async execute(
    request: MutationRequest,
    resolvedTargets: ResolvedTarget[],
    plan: PlanRecord,
    correlationId: string,
    resolveAuthContext: (
      targetProjectId: string
    ) => AuthContext | AppwriteMcpError
  ): Promise<TargetExecutionResult[]> {
    const results: TargetExecutionResult[] = [];

    for (const target of resolvedTargets) {
      const authContext = resolveAuthContext(target.project_id);
      if (authContext instanceof AppwriteMcpError) {
        results.push({
          target: target.source,
          project_id: target.project_id,
          status: "FAILED",
          operations: this.buildTargetPreflightFailures(
            request.actor,
            target.project_id,
            correlationId,
            request.operations,
            authContext
          )
        });
        continue;
      }

      const authContextError = this.validateTargetAuthContext(
        authContext,
        target.project_id
      );
      if (authContextError) {
        results.push({
          target: target.source,
          project_id: target.project_id,
          status: "FAILED",
          operations: this.buildTargetPreflightFailures(
            request.actor,
            target.project_id,
            correlationId,
            request.operations,
            authContextError
          )
        });
        continue;
      }

      const operationResults: TargetOperationResult[] = [];

      for (const operation of request.operations) {
        const result = await this.executeOperation(
          request.actor,
          operation,
          target.project_id,
          correlationId,
          authContext
        );

        operationResults.push(result);
      }

      const targetStatus = operationResults.every((entry) => entry.status === "SUCCESS")
        ? "SUCCESS"
        : "FAILED";

      results.push({
        target: target.source,
        project_id: target.project_id,
        status: targetStatus,
        operations: operationResults
      });
    }

    if (results.some((entry) => entry.status === "FAILED")) {
      return results;
    }

    for (const targetProject of plan.target_projects) {
      this.options.auditLogger.append({
        actor: request.actor,
        timestamp: this.options.now().toISOString(),
        target_project: targetProject,
        operation_id: "apply",
        outcome: "success",
        correlation_id: correlationId
      });
    }

    return results;
  }

  private async executeOperation(
    actor: string,
    operation: MutationOperation,
    targetProjectId: string,
    correlationId: string,
    authContext: AuthContext
  ): Promise<TargetOperationResult> {
    const effectiveAuthContext = this.resolveOperationAuthContext(
      operation,
      targetProjectId,
      authContext
    );
    if (effectiveAuthContext instanceof AppwriteMcpError) {
      return this.logAndBuildFailure(
        actor,
        targetProjectId,
        correlationId,
        operation.operation_id,
        toStandardError(effectiveAuthContext)
      );
    }

    const authContextError = this.validateTargetAuthContext(
      effectiveAuthContext,
      targetProjectId
    );
    if (authContextError) {
      return this.logAndBuildFailure(
        actor,
        targetProjectId,
        correlationId,
        operation.operation_id,
        toStandardError(authContextError)
      );
    }

    const missingScopes = this.findMissingScopes(
      operation.required_scopes ?? [],
      effectiveAuthContext.scopes
    );
    if (missingScopes.length > 0) {
      const capabilityError = new AppwriteMcpError(
        "MISSING_SCOPE",
        "required scopes are missing for operation",
        {
          target: targetProjectId,
          operation_id: operation.operation_id,
          missing_scopes: missingScopes,
          remediation: "Use an API key with required permissions and retry"
        }
      );

      return this.logAndBuildFailure(
        actor,
        targetProjectId,
        correlationId,
        operation.operation_id,
        toStandardError(capabilityError)
      );
    }

    const idempotencyKey = this.buildIdempotencyKey(targetProjectId, operation);
    if (idempotencyKey) {
      const cachedResult = this.idempotencyRegistry.get(idempotencyKey);
      if (cachedResult) {
        this.options.auditLogger.append({
          actor,
          timestamp: this.options.now().toISOString(),
          target_project: targetProjectId,
          operation_id: operation.operation_id,
          outcome: "skipped",
          correlation_id: correlationId,
          details: { idempotency_key: operation.idempotency_key }
        });

        return cachedResult;
      }
    }

    const execution = await this.options.adapter.executeOperation({
      target_project_id: targetProjectId,
      operation,
      auth_context: effectiveAuthContext,
      correlation_id: correlationId
    });

    if (!execution.ok) {
      const normalizedError = this.normalizeAndRedactError(
        execution.error,
        targetProjectId,
        operation.operation_id
      );

      return this.logAndBuildFailure(
        actor,
        targetProjectId,
        correlationId,
        operation.operation_id,
        normalizedError
      );
    }

    const successResult: TargetOperationResult = {
      operation_id: operation.operation_id,
      status: "SUCCESS",
      data: redactSecrets(execution.data) as Record<string, unknown>
    };

    if (idempotencyKey) {
      this.idempotencyRegistry.set(idempotencyKey, successResult);
    }

    const successRecord: AuditRecord = {
      actor,
      timestamp: this.options.now().toISOString(),
      target_project: targetProjectId,
      operation_id: operation.operation_id,
      outcome: "success",
      correlation_id: correlationId,
      details: { params: operation.params }
    };
    this.options.auditLogger.append(successRecord);

    return successResult;
  }

  private logAndBuildFailure(
    actor: string,
    targetProjectId: string,
    correlationId: string,
    operationId: string,
    error: StandardError
  ): TargetOperationResult {
    this.options.auditLogger.append({
      actor,
      timestamp: this.options.now().toISOString(),
      target_project: targetProjectId,
      operation_id: operationId,
      outcome: "failed",
      correlation_id: correlationId,
      details: { error }
    });

    return {
      operation_id: operationId,
      status: "FAILED",
      error
    };
  }

  private normalizeAndRedactError(
    error: StandardError,
    fallbackTarget: string,
    fallbackOperationId: string
  ): StandardError {
    const merged: StandardError = {
      code: error.code,
      message: error.message,
      target: error.target || fallbackTarget,
      operation_id: error.operation_id || fallbackOperationId,
      retryable: error.retryable,
      missing_scopes: error.missing_scopes,
      supported_transports: error.supported_transports,
      remediation: error.remediation
    };

    return redactSecrets(merged) as StandardError;
  }

  private buildIdempotencyKey(
    targetProjectId: string,
    operation: MutationOperation
  ): string | undefined {
    if (!operation.idempotency_key) {
      return undefined;
    }

    return `${targetProjectId}:${operation.action}:${operation.idempotency_key}`;
  }

  private validateTargetAuthContext(
    authContext: AuthContext,
    targetProjectId: string
  ): AppwriteMcpError | undefined {
    if (authContext.endpoint && authContext.api_key) {
      return undefined;
    }

    return new AppwriteMcpError(
      "AUTH_CONTEXT_REQUIRED",
      "missing endpoint/api key for target",
      {
        target: targetProjectId,
        operation_id: "*",
        remediation:
          "Configure endpoint and api_key for this project in APPWRITE_PROJECT_AUTH_FILE"
      }
    );
  }

  private resolveOperationAuthContext(
    operation: MutationOperation,
    targetProjectId: string,
    targetAuthContext: AuthContext
  ): AuthContext | AppwriteMcpError {
    if (!operation.action.startsWith("project.")) {
      return targetAuthContext;
    }

    if (!this.options.projectManagementAvailable) {
      return new AppwriteMcpError(
        "CAPABILITY_UNAVAILABLE",
        "project management channel is not configured",
        {
          target: targetProjectId,
          operation_id: operation.operation_id,
          remediation: "Enable project management channel before retry"
        }
      );
    }

    if (this.options.managementAuthContext) {
      return this.options.managementAuthContext;
    }

    return new AppwriteMcpError(
      "CAPABILITY_UNAVAILABLE",
      "project management auth context is not configured",
      {
        target: targetProjectId,
        operation_id: operation.operation_id,
        remediation:
          "Configure management.api_key in APPWRITE_PROJECT_AUTH_FILE and retry"
      }
    );
  }

  private findMissingScopes(
    requiredScopes: string[],
    availableScopes: string[]
  ): string[] {
    if (availableScopes.length === 0) {
      return [];
    }

    return requiredScopes.filter((scope) => !availableScopes.includes(scope));
  }

  private buildTargetPreflightFailures(
    actor: string,
    targetProjectId: string,
    correlationId: string,
    operations: MutationOperation[],
    error: AppwriteMcpError
  ): TargetOperationResult[] {
    const baseError = toStandardError(error);

    return operations.map((operation) =>
      this.logAndBuildFailure(
        actor,
        targetProjectId,
        correlationId,
        operation.operation_id,
        {
          ...baseError,
          target: targetProjectId,
          operation_id: operation.operation_id
        }
      )
    );
  }
}
