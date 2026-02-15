import { AppwriteMcpError } from "../domain/errors.js";
import type {
  MutationRequest,
  OperationAction,
  PlanOperationDescriptor,
  PlanRecord,
  ResolvedTarget,
  RiskLevel
} from "../domain/types.js";
import { createPlanHash } from "./plan-hash.js";

const destructiveActions = new Set<OperationAction>([
  "project.delete",
  "database.delete_collection"
]);

interface PlanManagerOptions {
  now: () => Date;
  randomId: () => string;
  planTtlSeconds: number;
}

export class PlanManager {
  private readonly planStore = new Map<string, PlanRecord>();

  constructor(private readonly options: PlanManagerOptions) {}

  buildAndStorePlan(
    request: MutationRequest,
    resolvedTargets: ResolvedTarget[]
  ): PlanRecord {
    const plan = this.buildPlan(request, resolvedTargets);
    this.planStore.set(plan.plan_id, plan);
    return plan;
  }

  requireMatchingPlan(
    request: MutationRequest,
    resolvedTargets: ResolvedTarget[]
  ): PlanRecord {
    const planId = request.plan_id;
    const planHash = request.plan_hash;

    if (!planId || !planHash) {
      throw new AppwriteMcpError(
        "PLAN_MISMATCH",
        "apply requires plan_id and plan_hash",
        {
          target: "plan",
          operation_id: "*"
        }
      );
    }

    const existing = this.planStore.get(planId);
    if (!existing) {
      throw new AppwriteMcpError("PLAN_MISMATCH", "plan_id not found", {
        target: "plan",
        operation_id: "*"
      });
    }

    if (new Date(existing.expires_at).getTime() <= this.options.now().getTime()) {
      throw new AppwriteMcpError("PLAN_MISMATCH", "plan has expired", {
        target: "plan",
        operation_id: "*"
      });
    }

    if (existing.plan_hash !== planHash) {
      throw new AppwriteMcpError("PLAN_MISMATCH", "plan_hash mismatch", {
        target: "plan",
        operation_id: "*"
      });
    }

    const rebuilt = this.buildPlan({ ...request, mode: "preview" }, resolvedTargets);
    if (rebuilt.plan_hash !== existing.plan_hash) {
      throw new AppwriteMcpError("PLAN_MISMATCH", "request differs from preview", {
        target: "plan",
        operation_id: "*"
      });
    }

    return existing;
  }

  private buildPlan(
    request: MutationRequest,
    resolvedTargets: ResolvedTarget[]
  ): PlanRecord {
    const now = this.options.now();
    const createdAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + this.options.planTtlSeconds * 1000
    ).toISOString();
    const descriptors = request.operations.map((operation) =>
      this.toPlanDescriptor(operation.action, operation.destructive, operation.critical, resolvedTargets.length, operation.operation_id)
    );
    const destructiveCount = descriptors.filter((entry) => entry.destructive).length;
    const riskLevel = this.toRiskLevel(descriptors);
    const requiredScopes = this.uniqueSorted(
      request.operations.flatMap((operation) => operation.required_scopes ?? [])
    );
    const targetProjects = resolvedTargets.map((target) => target.project_id);

    const hashSeed = {
      actor: request.actor,
      mode: request.mode,
      target_projects: targetProjects,
      operations: request.operations.map((operation, index) => {
        const descriptor = descriptors[index];
        if (!descriptor) {
          throw new AppwriteMcpError(
            "INTERNAL_ERROR",
            "operation descriptor index mismatch",
            {
              target: "plan",
              operation_id: operation.operation_id,
              retryable: true
            }
          );
        }

        return {
          ...operation,
          params: operation.params,
          destructive: descriptor.destructive,
          critical: descriptor.critical,
          required_scopes: this.uniqueSorted(operation.required_scopes ?? [])
        };
      }),
      policy: "B"
    };

    const planHash = createPlanHash(hashSeed);

    return {
      plan_id: `plan_${this.options.randomId()}`,
      plan_hash: planHash,
      actor: request.actor,
      target_projects: targetProjects,
      operations: descriptors,
      required_scopes: requiredScopes,
      destructive_count: destructiveCount,
      risk_level: riskLevel,
      created_at: createdAt,
      expires_at: expiresAt
    };
  }

  private toPlanDescriptor(
    action: OperationAction,
    allowDestructiveOverride: boolean | undefined,
    allowCriticalOverride: boolean | undefined,
    targetCount: number,
    operationId: string
  ): PlanOperationDescriptor {
    const inferredDestructive = destructiveActions.has(action);
    const destructive = inferredDestructive || allowDestructiveOverride === true;
    const inferredCritical = action === "project.delete" || (destructive && targetCount >= 2);
    const critical =
      inferredCritical || allowCriticalOverride === true;

    return {
      operation_id: operationId,
      domain: this.toDomainFromAction(action),
      action,
      destructive,
      critical
    };
  }

  private toDomainFromAction(action: OperationAction): PlanOperationDescriptor["domain"] {
    if (action.startsWith("project.")) {
      return "project";
    }

    if (action.startsWith("database.")) {
      return "database";
    }

    if (action.startsWith("auth.")) {
      return "auth";
    }

    return "function";
  }

  private toRiskLevel(operations: PlanOperationDescriptor[]): RiskLevel {
    if (operations.some((operation) => operation.critical)) {
      return "HIGH";
    }

    if (operations.some((operation) => operation.destructive)) {
      return "MEDIUM";
    }

    return "LOW";
  }

  private uniqueSorted(values: string[]): string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
  }
}
