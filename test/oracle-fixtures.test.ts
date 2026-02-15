import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAppwriteControlService } from "../src/config/runtime-config.js";
import type { AppwriteAdapterExecutionInput, AdapterExecutionResult } from "../src/core/appwrite-adapter.js";
import { InMemoryAuditLogger } from "../src/core/audit-log.js";
import { AppwriteControlService } from "../src/core/appwrite-control-service.js";
import type {
  ApplyResponse,
  AuthContext,
  ErrorResponse,
  MutationErrorResponse,
  MutationOperation,
  PreviewResponse,
  StandardError
} from "../src/domain/types.js";

class TestClock {
  private current = Date.parse("2026-02-15T00:00:00.000Z");

  now = (): Date => new Date(this.current);

  advance(seconds: number): void {
    this.current += seconds * 1000;
  }
}

class FakeAdapter {
  readonly calls: AppwriteAdapterExecutionInput[] = [];
  private readonly failures = new Map<string, StandardError>();

  setFailure(
    targetProjectId: string,
    operationId: string,
    error: StandardError
  ): void {
    this.failures.set(`${targetProjectId}:${operationId}`, error);
  }

  executeOperation = async (
    input: AppwriteAdapterExecutionInput
  ): Promise<AdapterExecutionResult> => {
    this.calls.push(input);

    const failure = this.failures.get(
      `${input.target_project_id}:${input.operation.operation_id}`
    );
    if (failure) {
      return {
        ok: false,
        error: failure
      };
    }

    if (input.operation.action === "project.create") {
      return {
        ok: true,
        data: {
          project_id: `created-${input.target_project_id}`,
          name: input.operation.params.name ?? "unnamed-project"
        }
      };
    }

    return {
      ok: true,
      data: {
        action: input.operation.action,
        project_id: input.target_project_id,
        ok: true
      }
    };
  };
}

interface ServiceBuildOptions {
  scopes?: string[];
  aliasMap?: Record<string, string>;
  projectManagementAvailable?: boolean;
  requestedTransport?: string;
  supportedTransports?: string[];
  endpoint?: string | null;
  apiKey?: string | null;
  projectAuthContexts?: Record<string, AuthContext>;
  knownProjectIds?: string[];
  autoTargetProjectIds?: string[];
  defaultTargetSelector?: { mode?: "auto" | "alias" | "project_id"; value?: string; values?: string[] };
}

const buildService = (options: ServiceBuildOptions = {}) => {
  const adapter = new FakeAdapter();
  const clock = new TestClock();
  let sequence = 0;
  const endpoint =
    options.endpoint === undefined
      ? "https://example.appwrite.test/v1"
      : (options.endpoint ?? undefined);
  const apiKey =
    options.apiKey === undefined ? "sk_test_key" : (options.apiKey ?? undefined);

  const service = new AppwriteControlService({
    adapter,
    auditLogger: new InMemoryAuditLogger(),
    authContext: {
      endpoint,
      api_key: apiKey,
      scopes:
        options.scopes ??
        [
          "databases.write",
          "users.read",
          "users.write",
          "functions.write",
          "projects.write"
        ]
    },
    projectAuthContexts: options.projectAuthContexts,
    confirmationSecret: "test-confirmation-secret",
    aliasMap: options.aliasMap ?? {},
    projectManagementAvailable: options.projectManagementAvailable ?? true,
    knownProjectIds: options.knownProjectIds,
    autoTargetProjectIds: options.autoTargetProjectIds,
    defaultTargetSelector: options.defaultTargetSelector,
    transportDefault: "stdio",
    supportedTransports: options.supportedTransports ?? ["stdio"],
    requestedTransport: options.requestedTransport,
    now: clock.now,
    randomId: () => `id-${sequence++}`,
    planTtlSeconds: 600
  });

  return {
    service,
    adapter,
    clock
  };
};

const isMutationFailure = (
  value: PreviewResponse | ApplyResponse | MutationErrorResponse
): value is MutationErrorResponse =>
  value.status === "FAILED" && "error" in value;

const isErrorResponse = (value: unknown): value is ErrorResponse => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const typed = value as { status?: unknown; error?: unknown };
  return typed.status === "FAILED" && typeof typed.error === "object";
};

const expectPreviewSuccess = (
  value: PreviewResponse | MutationErrorResponse
): PreviewResponse => {
  if (isMutationFailure(value)) {
    throw new Error(`Expected preview success, received ${value.error.code}`);
  }

  return value;
};

const expectApplySuccess = (
  value: ApplyResponse | MutationErrorResponse
): ApplyResponse => {
  if (isMutationFailure(value)) {
    throw new Error(`Expected apply success, received ${value.error.code}`);
  }

  return value;
};

const expectApplyFailure = (
  value: ApplyResponse | MutationErrorResponse,
  code: string
): MutationErrorResponse => {
  if (!isMutationFailure(value)) {
    throw new Error("Expected apply failure but got success");
  }

  expect(value.error.code).toBe(code);
  return value;
};

const baseOperation = (overrides: Partial<MutationOperation> = {}): MutationOperation => ({
  operation_id: overrides.operation_id ?? "op-1",
  domain: overrides.domain ?? "database",
  action: overrides.action ?? "database.create",
  params: overrides.params ?? { database_id: "db-main", name: "Main DB" },
  required_scopes: overrides.required_scopes ?? ["databases.write"],
  destructive: overrides.destructive,
  critical: overrides.critical,
  idempotency_key: overrides.idempotency_key
});

const createRuntimeAuthFile = (
  projects: Record<
    string,
    {
      api_key: string;
      scopes: string[];
      endpoint?: string;
    }
  >,
  defaultEndpoint = "https://example.appwrite.test/v1"
): { filePath: string; cleanup: () => void } => {
  const directory = mkdtempSync(join(tmpdir(), "appwrite-mcp-auth-"));
  const filePath = join(directory, "project-auth.json");

  writeFileSync(
    filePath,
    JSON.stringify(
      {
        default_endpoint: defaultEndpoint,
        projects
      },
      null,
      2
    ),
    "utf8"
  );

  return {
    filePath,
    cleanup: () => {
      rmSync(directory, { recursive: true, force: true });
    }
  };
};

describe("ORC fixtures", () => {
  it("ORC-FX-001: returns capability domains and transport metadata", () => {
    const { service } = buildService({ projectManagementAvailable: true });
    const response = service.listCapabilities();

    expect(response.status).toBe("SUCCESS");
    if (response.status !== "SUCCESS") {
      return;
    }

    expect(response.capabilities.domains.project.enabled).toBe(true);
    expect(response.capabilities.domains.database.enabled).toBe(true);
    expect(response.capabilities.domains.auth.enabled).toBe(true);
    expect(response.capabilities.domains.function.enabled).toBe(true);
    expect(response.capabilities.domains.operation.enabled).toBe(true);
    expect(response.capabilities.transport_default).toBe("stdio");
    expect(response.capabilities.supported_transports).toEqual(["stdio"]);
  });

  it("ORC-FX-002: preview returns plan metadata and one-line summary", () => {
    const { service } = buildService();
    const preview = service.preview({
      actor: "tester",
      targets: [{ project_id: "P_A" }, { project_id: "P_B" }],
      operations: [
        baseOperation({ operation_id: "op-db-1" }),
        baseOperation({
          operation_id: "op-db-2",
          action: "database.delete_collection",
          params: {
            database_id: "db-main",
            collection_id: "legacy"
          },
          destructive: true
        })
      ]
    });

    const success = expectPreviewSuccess(preview);
    expect(success.plan_id).toMatch(/^plan_/);
    expect(success.plan_hash.length).toBeGreaterThan(20);
    expect(success.target_projects).toEqual(["P_A", "P_B"]);
    expect(success.operations.length).toBe(2);
    expect(success.destructive_count).toBe(1);
    expect(success.required_scopes).toEqual(["databases.write"]);
    expect(success.summary).toContain("targets=2");
  });

  it("ORC-FX-003: multi-target apply preserves input order and returns PARTIAL_SUCCESS", async () => {
    const { service, adapter } = buildService();

    adapter.setFailure("P_B", "op-1", {
      code: "INTERNAL_ERROR",
      message: "permission denied",
      target: "P_B",
      operation_id: "op-1",
      retryable: false
    });

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "P_A" }, { project_id: "P_B" }],
        operations: [baseOperation()]
      })
    );

    const apply = expectApplySuccess(
      await service.apply({
        actor: "tester",
        targets: [{ project_id: "P_A" }, { project_id: "P_B" }],
        operations: [baseOperation()],
        plan_id: preview.plan_id,
        plan_hash: preview.plan_hash
      })
    );

    expect(apply.status).toBe("PARTIAL_SUCCESS");
    expect(apply.target_results[0].project_id).toBe("P_A");
    expect(apply.target_results[1].project_id).toBe("P_B");
    expect(apply.target_results[0].status).toBe("SUCCESS");
    expect(apply.target_results[1].status).toBe("FAILED");
  });

  it("ORC-FX-004: plan hash mismatch returns PLAN_MISMATCH without side effects", async () => {
    const { service, adapter } = buildService();

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        operations: [baseOperation()]
      })
    );

    const apply = await service.apply({
      actor: "tester",
      targets: [{ project_id: "P_A" }],
      operations: [baseOperation()],
      plan_id: preview.plan_id,
      plan_hash: `${preview.plan_hash}-tampered`
    });

    expectApplyFailure(apply, "PLAN_MISMATCH");
    expect(adapter.calls).toHaveLength(0);
  });

  it("ORC-FX-005: project.create returns created project metadata", async () => {
    const { service } = buildService({ projectManagementAvailable: true });

    const operation = baseOperation({
      operation_id: "op-project-create",
      domain: "project",
      action: "project.create",
      params: { name: "new-service" },
      required_scopes: ["projects.write"]
    });

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "mgmt" }],
        operations: [operation]
      })
    );

    const apply = expectApplySuccess(
      await service.apply({
        actor: "tester",
        targets: [{ project_id: "mgmt" }],
        operations: [operation],
        plan_id: preview.plan_id,
        plan_hash: preview.plan_hash
      })
    );

    expect(apply.target_results[0].operations[0].status).toBe("SUCCESS");
    expect(apply.target_results[0].operations[0].data?.project_id).toBe("created-mgmt");
  });

  it("ORC-FX-006: project.create fails with CAPABILITY_UNAVAILABLE when management channel is absent", async () => {
    const { service } = buildService({ projectManagementAvailable: false });

    const operation = baseOperation({
      operation_id: "op-project-create",
      domain: "project",
      action: "project.create",
      params: { name: "new-service" },
      required_scopes: ["projects.write"]
    });

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "mgmt" }],
        operations: [operation]
      })
    );

    const apply = expectApplySuccess(
      await service.apply({
        actor: "tester",
        targets: [{ project_id: "mgmt" }],
        operations: [operation],
        plan_id: preview.plan_id,
        plan_hash: preview.plan_hash
      })
    );

    expect(apply.status).toBe("FAILED");
    expect(apply.target_results[0].operations[0].error?.code).toBe(
      "CAPABILITY_UNAVAILABLE"
    );
  });

  it("ORC-FX-007: policy B auto-applies NON_CRITICAL destructive operations", async () => {
    const { service, adapter } = buildService();

    const operation = baseOperation({
      operation_id: "op-delete-collection",
      action: "database.delete_collection",
      params: { database_id: "db-main", collection_id: "old" },
      destructive: true
    });

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        operations: [operation]
      })
    );

    const apply = expectApplySuccess(
      await service.apply({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        operations: [operation],
        plan_id: preview.plan_id,
        plan_hash: preview.plan_hash
      })
    );

    expect(apply.status).toBe("SUCCESS");
    expect(adapter.calls).toHaveLength(1);
  });

  it("ORC-FX-008: critical destructive operations require confirmation token", async () => {
    const { service, adapter } = buildService({ projectManagementAvailable: true });

    const operation = baseOperation({
      operation_id: "op-project-delete",
      domain: "project",
      action: "project.delete",
      params: { project_id: "P_A" },
      required_scopes: ["projects.write"]
    });

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        operations: [operation]
      })
    );

    const withoutToken = await service.apply({
      actor: "tester",
      targets: [{ project_id: "P_A" }],
      operations: [operation],
      plan_id: preview.plan_id,
      plan_hash: preview.plan_hash
    });

    expectApplyFailure(withoutToken, "CONFIRM_REQUIRED");
    expect(adapter.calls).toHaveLength(0);

    const issue = service.issueConfirmationToken({
      plan_hash: preview.plan_hash,
      ttl_seconds: 300
    });

    expect(issue.status).toBe("SUCCESS");
    if (issue.status !== "SUCCESS") {
      throw new Error("expected token issuance success");
    }

    const withToken = expectApplySuccess(
      await service.apply({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        operations: [operation],
        plan_id: preview.plan_id,
        plan_hash: preview.plan_hash,
        confirmation_token: issue.token
      })
    );

    expect(withToken.status).toBe("SUCCESS");
    expect(adapter.calls).toHaveLength(1);
  });

  it("ORC-FX-009: supports minimum DB/Auth/Function operation set", async () => {
    const { service, adapter } = buildService();

    const operations: MutationOperation[] = [
      baseOperation({
        operation_id: "op-db-upsert",
        action: "database.upsert_collection",
        params: { database_id: "db-main", collection_id: "users" }
      }),
      baseOperation({
        operation_id: "op-user-list",
        domain: "auth",
        action: "auth.users.list",
        params: { limit: 10 },
        required_scopes: ["users.write"]
      }),
      baseOperation({
        operation_id: "op-user-create",
        domain: "auth",
        action: "auth.users.create",
        params: { user_id: "u_01", email: "x@test.local" },
        required_scopes: ["users.write"]
      }),
      baseOperation({
        operation_id: "op-user-update",
        domain: "auth",
        action: "auth.users.update",
        params: { user_id: "u_01", name: "updated" },
        required_scopes: ["users.write"]
      }),
      baseOperation({
        operation_id: "op-fn-create",
        domain: "function",
        action: "function.create",
        params: { function_id: "f_01", name: "worker" },
        required_scopes: ["functions.write"]
      }),
      baseOperation({
        operation_id: "op-fn-update",
        domain: "function",
        action: "function.update",
        params: { function_id: "f_01", name: "worker-v2" },
        required_scopes: ["functions.write"]
      }),
      baseOperation({
        operation_id: "op-fn-deploy",
        domain: "function",
        action: "function.deployment.trigger",
        params: { function_id: "f_01", code: "bundle" },
        required_scopes: ["functions.write"]
      }),
      baseOperation({
        operation_id: "op-fn-exec",
        domain: "function",
        action: "function.execution.trigger",
        params: { function_id: "f_01", body: "{}" },
        required_scopes: ["functions.write"]
      }),
      baseOperation({
        operation_id: "op-fn-exec-status",
        domain: "function",
        action: "function.execution.status",
        params: { function_id: "f_01", execution_id: "e_01" },
        required_scopes: ["functions.write"]
      })
    ];

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        operations
      })
    );

    const apply = expectApplySuccess(
      await service.apply({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        operations,
        plan_id: preview.plan_id,
        plan_hash: preview.plan_hash
      })
    );

    expect(apply.status).toBe("SUCCESS");
    expect(adapter.calls.map((call) => call.operation.action)).toEqual(
      operations.map((operation) => operation.action)
    );
  });

  it("ORC-FX-010: validates scopes before apply and passes explicit project context", async () => {
    const { service, adapter } = buildService({
      scopes: ["users.write"],
      aliasMap: { prod: "P_PROD" }
    });

    const operation = baseOperation({
      operation_id: "op-db-create",
      action: "database.create",
      required_scopes: ["databases.write"]
    });

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ alias: "prod" }],
        operations: [operation]
      })
    );

    const applyFailure = await service.apply({
      actor: "tester",
      targets: [{ alias: "prod" }],
      operations: [operation],
      plan_id: preview.plan_id,
      plan_hash: preview.plan_hash
    });

    expectApplyFailure(applyFailure, "MISSING_SCOPE");
    expect(adapter.calls).toHaveLength(0);

    const { service: scopedService, adapter: scopedAdapter } = buildService({
      scopes: ["databases.write"],
      aliasMap: { prod: "P_PROD" }
    });

    const scopedPreview = expectPreviewSuccess(
      scopedService.preview({
        actor: "tester",
        targets: [{ alias: "prod" }],
        operations: [operation]
      })
    );

    const scopedApply = expectApplySuccess(
      await scopedService.apply({
        actor: "tester",
        targets: [{ alias: "prod" }],
        operations: [operation],
        plan_id: scopedPreview.plan_id,
        plan_hash: scopedPreview.plan_hash
      })
    );

    expect(scopedApply.status).toBe("SUCCESS");
    expect(scopedAdapter.calls[0].target_project_id).toBe("P_PROD");
  });

  it("ORC-FX-011: emits audit fields, redacts secrets, returns standardized errors, and supports idempotency", async () => {
    const { service, adapter } = buildService();

    adapter.setFailure("P_A", "op-fail", {
      code: "INTERNAL_ERROR",
      message: "upstream leaked token bearer abcdef",
      target: "P_A",
      operation_id: "op-fail",
      retryable: true
    });

    const operations: MutationOperation[] = [
      baseOperation({
        operation_id: "op-safe",
        params: {
          database_id: "db-main",
          apiKey: "should-not-leak",
          token: "bearer abcdef"
        },
        idempotency_key: "idemp-1"
      }),
      baseOperation({
        operation_id: "op-fail",
        action: "database.delete_collection",
        destructive: true,
        params: { database_id: "db-main", collection_id: "legacy" }
      })
    ];

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        operations
      })
    );

    const apply1 = expectApplySuccess(
      await service.apply({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        operations,
        plan_id: preview.plan_id,
        plan_hash: preview.plan_hash
      })
    );

    expect(apply1.correlation_id.length).toBeGreaterThan(6);
    const opFailure = apply1.target_results[0].operations.find(
      (entry) => entry.operation_id === "op-fail"
    );
    expect(opFailure?.error?.code).toBe("INTERNAL_ERROR");
    expect(opFailure?.error?.target).toBe("P_A");
    expect(opFailure?.error?.operation_id).toBe("op-fail");
    expect(typeof opFailure?.error?.retryable).toBe("boolean");
    expect(opFailure?.error?.message).not.toContain("bearer");
    expect(opFailure?.error?.message).toContain("[REDACTED]");

    const apply2 = expectApplySuccess(
      await service.apply({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        operations,
        plan_id: preview.plan_id,
        plan_hash: preview.plan_hash
      })
    );

    expect(apply2.status).toBe("FAILED");
    const safeCalls = adapter.calls.filter(
      (call) => call.operation.operation_id === "op-safe"
    );
    expect(safeCalls).toHaveLength(1);

    const auditRecords = service.getAuditRecords();
    expect(auditRecords.length).toBeGreaterThan(0);
    expect(auditRecords[0]).toHaveProperty("actor");
    expect(auditRecords[0]).toHaveProperty("timestamp");
    expect(auditRecords[0]).toHaveProperty("target_project");
    expect(auditRecords[0]).toHaveProperty("operation_id");
    expect(auditRecords[0]).toHaveProperty("outcome");

    const redactedRecord = auditRecords.find(
      (entry) => entry.operation_id === "op-safe" && entry.outcome === "success"
    );
    const serialized = JSON.stringify(redactedRecord);
    expect(serialized).not.toContain("should-not-leak");
    expect(serialized).toContain("[REDACTED]");
  });

  it("ORC-FX-012: stdio mode defaults and keeps stdout protocol-pure", async () => {
    const authFile = createRuntimeAuthFile({
      P_DEFAULT: {
        api_key: "sk_test_key",
        scopes: ["databases.write"]
      }
    });
    const cwd = resolve(__dirname, "..");
    try {
      const child = spawn("./node_modules/.bin/tsx", ["src/index.ts"], {
        cwd,
        env: {
          ...process.env,
          APPWRITE_PROJECT_AUTH_FILE: authFile.filePath
        },
        stdio: ["pipe", "pipe", "pipe"]
      });

      const lines: string[] = [];
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        lines.push(...chunk.split("\n").filter((line) => line.trim().length > 0));
      });

      const initializeMessage = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {}
      };

      const capabilityCall = {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "capabilities.list",
          arguments: {}
        }
      };

      child.stdin.write(`${JSON.stringify(initializeMessage)}\n`);
      child.stdin.write(`${JSON.stringify(capabilityCall)}\n`);
      child.stdin.end();

      await once(child, "exit");

      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }

      const capabilityResponse = JSON.parse(lines[1]) as {
        result?: { content?: Array<{ json?: { capabilities?: { transport_default?: string } } }> };
      };

      expect(
        capabilityResponse.result?.content?.[0]?.json?.capabilities?.transport_default
      ).toBe("stdio");
    } finally {
      authFile.cleanup();
    }
  });

  it("ORC-FX-013: unsupported transport returns CAPABILITY_UNAVAILABLE with supported_transports", async () => {
    const { service, adapter } = buildService({
      supportedTransports: ["stdio"],
      requestedTransport: "streamable-http"
    });

    const preview = service.preview({
      actor: "tester",
      targets: [{ project_id: "P_A" }],
      operations: [baseOperation()]
    });

    if (!isMutationFailure(preview)) {
      throw new Error("expected transport failure");
    }

    const failure = preview;
    expect(failure.error.code).toBe("CAPABILITY_UNAVAILABLE");

    expect(failure.error.supported_transports).toEqual(["stdio"]);
    expect(adapter.calls).toHaveLength(0);
  });

  it("ORC-FX-014: stdio auth context must come from environment, not payload credentials", async () => {
    const { service, adapter } = buildService({ endpoint: null, apiKey: null });

    const operation = baseOperation();
    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        operations: [operation]
      })
    );

    const apply = await service.apply({
      actor: "tester",
      targets: [{ project_id: "P_A" }],
      operations: [operation],
      plan_id: preview.plan_id,
      plan_hash: preview.plan_hash,
      credentials: {
        endpoint: "https://payload-only.example",
        api_key: "payload-key"
      }
    });

    expectApplyFailure(apply, "AUTH_CONTEXT_REQUIRED");
    expect(adapter.calls).toHaveLength(0);
  });

  it("ORC-FX-015: loads project auth file semantics and applies per-target auth contexts", async () => {
    const { service, adapter } = buildService({
      projectAuthContexts: {
        P_A: {
          endpoint: "https://example.appwrite.test/v1",
          api_key: "sk_project_a",
          scopes: ["databases.write"]
        },
        P_B: {
          endpoint: "https://example.appwrite.test/v1",
          api_key: "sk_project_b",
          scopes: ["databases.write"]
        }
      }
    });

    const operation = baseOperation({
      operation_id: "op-auth-map"
    });

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "P_A" }, { project_id: "P_B" }],
        operations: [operation]
      })
    );

    const apply = expectApplySuccess(
      await service.apply({
        actor: "tester",
        targets: [{ project_id: "P_A" }, { project_id: "P_B" }],
        operations: [operation],
        plan_id: preview.plan_id,
        plan_hash: preview.plan_hash
      })
    );

    expect(apply.status).toBe("SUCCESS");
    const callA = adapter.calls.find((call) => call.target_project_id === "P_A");
    const callB = adapter.calls.find((call) => call.target_project_id === "P_B");
    expect(callA?.auth_context.api_key).toBe("sk_project_a");
    expect(callB?.auth_context.api_key).toBe("sk_project_b");
  });

  it("ORC-FX-016A~D: startup fails fast across auth file boundary errors", () => {
    // ORC-FX-016A: missing path
    expect(() =>
      buildAppwriteControlService({
        argv: [],
        env: {}
      })
    ).toThrow("APPWRITE_PROJECT_AUTH_FILE is required");

    const brokenDir = mkdtempSync(join(tmpdir(), "appwrite-mcp-auth-invalid-"));
    const brokenFilePath = join(brokenDir, "broken.json");
    const schemaMissingRootFilePath = join(brokenDir, "missing-root.json");
    const schemaMissingNestedFilePath = join(brokenDir, "missing-nested.json");
    writeFileSync(brokenFilePath, "{invalid-json", "utf8");
    writeFileSync(
      schemaMissingRootFilePath,
      JSON.stringify(
        {
          projects: {
            P_A: {
              api_key: "sk_project_a",
              scopes: ["databases.write"]
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );
    writeFileSync(
      schemaMissingNestedFilePath,
      JSON.stringify(
        {
          default_endpoint: "https://example.appwrite.test/v1",
          projects: {
            P_A: {
              api_key: "sk_project_a"
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    try {
      // ORC-FX-016B: unreadable path (directory path as file input)
      expect(() =>
        buildAppwriteControlService({
          argv: [],
          env: {
            APPWRITE_PROJECT_AUTH_FILE: brokenDir
          }
        })
      ).toThrow("APPWRITE_PROJECT_AUTH_FILE read failed");

      // ORC-FX-016C: invalid JSON
      expect(() =>
        buildAppwriteControlService({
          argv: [],
          env: {
            APPWRITE_PROJECT_AUTH_FILE: brokenFilePath
          }
        })
      ).toThrow("APPWRITE_PROJECT_AUTH_FILE must contain valid JSON");

      // ORC-FX-016D: required field missing (root + nested required path)
      expect(() =>
        buildAppwriteControlService({
          argv: [],
          env: {
            APPWRITE_PROJECT_AUTH_FILE: schemaMissingRootFilePath
          }
        })
      ).toThrow(/APPWRITE_PROJECT_AUTH_FILE schema invalid at default_endpoint/);
      expect(() =>
        buildAppwriteControlService({
          argv: [],
          env: {
            APPWRITE_PROJECT_AUTH_FILE: schemaMissingNestedFilePath
          }
        })
      ).toThrow(/APPWRITE_PROJECT_AUTH_FILE schema invalid at projects\.P_A\.scopes/);
    } finally {
      rmSync(brokenDir, { recursive: true, force: true });
    }
  });

  it("ORC-FX-017: missing project auth entry fails target with AUTH_CONTEXT_REQUIRED and remediation", async () => {
    const { service, adapter } = buildService({
      projectAuthContexts: {
        P_A: {
          endpoint: "https://example.appwrite.test/v1",
          api_key: "sk_project_a",
          scopes: ["databases.write"]
        }
      }
    });

    const operation = baseOperation({
      operation_id: "op-missing-project-auth"
    });

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "P_A" }, { project_id: "P_B" }],
        operations: [operation]
      })
    );

    const apply = expectApplySuccess(
      await service.apply({
        actor: "tester",
        targets: [{ project_id: "P_A" }, { project_id: "P_B" }],
        operations: [operation],
        plan_id: preview.plan_id,
        plan_hash: preview.plan_hash
      })
    );

    expect(apply.status).toBe("PARTIAL_SUCCESS");
    expect(adapter.calls.map((call) => call.target_project_id)).toEqual(["P_A"]);
    const failedTarget = apply.target_results.find((result) => result.project_id === "P_B");
    expect(failedTarget?.status).toBe("FAILED");
    expect(failedTarget?.operations[0]?.error?.code).toBe("AUTH_CONTEXT_REQUIRED");
    expect(failedTarget?.operations[0]?.error?.remediation).toContain(
      "APPWRITE_PROJECT_AUTH_FILE"
    );
  });

  it("ORC-FX-018: validates scopes per target auth context before execution", async () => {
    const { service, adapter } = buildService({
      projectAuthContexts: {
        P_A: {
          endpoint: "https://example.appwrite.test/v1",
          api_key: "sk_project_a",
          scopes: ["databases.write"]
        },
        P_B: {
          endpoint: "https://example.appwrite.test/v1",
          api_key: "sk_project_b",
          scopes: []
        }
      }
    });

    const operation = baseOperation({
      operation_id: "op-target-scope-check",
      required_scopes: ["databases.write"]
    });

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "P_A" }, { project_id: "P_B" }],
        operations: [operation]
      })
    );

    const apply = expectApplySuccess(
      await service.apply({
        actor: "tester",
        targets: [{ project_id: "P_A" }, { project_id: "P_B" }],
        operations: [operation],
        plan_id: preview.plan_id,
        plan_hash: preview.plan_hash
      })
    );

    expect(apply.status).toBe("PARTIAL_SUCCESS");
    expect(adapter.calls.map((call) => call.target_project_id)).toEqual(["P_A"]);
    const failedTarget = apply.target_results.find((result) => result.project_id === "P_B");
    expect(failedTarget?.operations[0]?.error?.code).toBe("MISSING_SCOPE");
    expect(failedTarget?.operations[0]?.error?.missing_scopes).toEqual([
      "databases.write"
    ]);
  });

  it("ORC-FX-019: payload credentials must not override file-based target auth context", async () => {
    const { service, adapter } = buildService({
      projectAuthContexts: {
        P_A: {
          endpoint: "https://file-endpoint.example/v1",
          api_key: "sk_from_file",
          scopes: ["databases.write"]
        }
      }
    });

    const operation = baseOperation({
      operation_id: "op-payload-credentials-ignored"
    });

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        operations: [operation]
      })
    );

    const apply = expectApplySuccess(
      await service.apply({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        operations: [operation],
        plan_id: preview.plan_id,
        plan_hash: preview.plan_hash,
        credentials: {
          endpoint: "https://payload-endpoint.example/v1",
          api_key: "payload-secret-key"
        }
      })
    );

    expect(apply.status).toBe("SUCCESS");
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.auth_context.endpoint).toBe(
      "https://file-endpoint.example/v1"
    );
    expect(adapter.calls[0]?.auth_context.api_key).toBe("sk_from_file");
    expect(JSON.stringify(apply)).not.toContain("payload-secret-key");
  });

  it("ORC-FX-020: infers required_scopes from catalog when omitted", () => {
    const { service } = buildService();

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        operations: [
          {
            operation_id: "op-infer-scope",
            domain: "auth",
            action: "auth.users.list",
            params: { limit: 1 }
          }
        ]
      })
    );

    expect(preview.required_scopes).toEqual(["users.read"]);
  });

  it("ORC-FX-021: auto selector resolves configured default targets without explicit targets[]", () => {
    const { service } = buildService({
      knownProjectIds: ["P_A", "P_B"],
      autoTargetProjectIds: ["P_B"]
    });

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        target_selector: { mode: "auto" },
        operations: [baseOperation()]
      })
    );

    expect(preview.target_projects).toEqual(["P_B"]);
  });

  it("ORC-FX-022: auto selector fails closed as TARGET_AMBIGUOUS when defaults are absent", () => {
    const { service } = buildService({
      knownProjectIds: ["P_A", "P_B"]
    });

    const preview = service.preview({
      actor: "tester",
      target_selector: { mode: "auto" },
      operations: [baseOperation()]
    });

    if (!isMutationFailure(preview)) {
      throw new Error("expected auto target ambiguity failure");
    }

    expect(preview.error.code).toBe("TARGET_AMBIGUOUS");
  });

  it("ORC-FX-023: exposes runtime context and scope catalog tools", () => {
    const { service } = buildService({
      aliasMap: { prod: "P_A" },
      knownProjectIds: ["P_A", "P_B"],
      autoTargetProjectIds: ["P_A"]
    });

    const context = service.getRuntimeContext();
    expect(context.status).toBe("SUCCESS");
    expect(context.context.known_project_ids).toEqual(["P_A", "P_B"]);
    expect(context.context.alias_count).toBe(1);
    expect(context.context.auto_target_project_ids).toEqual(["P_A"]);

    const catalog = service.getScopeCatalog();
    expect(catalog.status).toBe("SUCCESS");
    expect(catalog.actions["auth.users.list"].required_scopes).toEqual([
      "users.read"
    ]);
  });

  it("ORC-FX-024: resolves target selector through service helper", () => {
    const { service } = buildService({
      aliasMap: { prod: "P_A" },
      knownProjectIds: ["P_A", "P_B"],
      autoTargetProjectIds: ["P_A"]
    });

    const resolved = service.resolveTargets({
      targets: [],
      target_selector: {
        mode: "alias",
        value: "prod"
      }
    });

    expect(resolved.status).toBe("SUCCESS");
    if (resolved.status !== "SUCCESS") {
      throw new Error("expected target resolve success");
    }

    expect(resolved.resolved_targets).toEqual(["P_A"]);
    expect(resolved.source).toBe("selector");
  });

  it("ORC-FX-025: explicit targets take precedence over target_selector", () => {
    const { service } = buildService({
      aliasMap: { prod: "P_B" },
      knownProjectIds: ["P_A", "P_B"],
      autoTargetProjectIds: ["P_B"]
    });

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        target_selector: {
          mode: "alias",
          value: "prod"
        },
        operations: [baseOperation()]
      })
    );

    expect(preview.target_projects).toEqual(["P_A"]);

    const resolved = service.resolveTargets({
      targets: [{ project_id: "P_A" }],
      target_selector: {
        mode: "alias",
        value: "prod"
      }
    });

    expect(resolved.status).toBe("SUCCESS");
    if (resolved.status !== "SUCCESS") {
      throw new Error("expected explicit target resolution success");
    }
    expect(resolved.source).toBe("explicit");
    expect(resolved.resolved_targets).toEqual(["P_A"]);
  });

  it("ORC-FX-026: required_scopes cannot be downgraded below catalog minimum", () => {
    const { service } = buildService({
      scopes: ["users.read"]
    });

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        operations: [
          {
            operation_id: "op-users-create-underdeclare",
            domain: "auth",
            action: "auth.users.create",
            params: { user_id: "u-1", email: "user@example.com" },
            required_scopes: ["users.read"]
          }
        ]
      })
    );

    expect(preview.required_scopes).toContain("users.write");
    expect(preview.required_scopes).toContain("users.read");
  });

  it("ORC-FX-027: client cannot downgrade destructive/critical policy by false override", async () => {
    const { service } = buildService({
      projectManagementAvailable: true
    });

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        operations: [
          {
            operation_id: "op-project-delete-policy",
            domain: "project",
            action: "project.delete",
            params: { project_id: "P_A" },
            required_scopes: ["projects.write"],
            destructive: false,
            critical: false
          }
        ]
      })
    );

    expect(preview.operations[0]?.destructive).toBe(true);
    expect(preview.operations[0]?.critical).toBe(true);

    const apply = await service.apply({
      actor: "tester",
      targets: [{ project_id: "P_A" }],
      operations: [
        {
          operation_id: "op-project-delete-policy",
          domain: "project",
          action: "project.delete",
          params: { project_id: "P_A" },
          required_scopes: ["projects.write"],
          destructive: false,
          critical: false
        }
      ],
      plan_id: preview.plan_id,
      plan_hash: preview.plan_hash
    });

    expectApplyFailure(apply, "CONFIRM_REQUIRED");
  });

  it("ORC-FX-028: production runtime requires non-default confirmation secret", () => {
    const authFile = createRuntimeAuthFile({
      P_A: {
        api_key: "sk_project_a",
        scopes: ["databases.write"]
      }
    });

    try {
      expect(() =>
        buildAppwriteControlService({
          argv: [],
          env: {
            APPWRITE_PROJECT_AUTH_FILE: authFile.filePath,
            NODE_ENV: "production"
          }
        })
      ).toThrow(
        "APPWRITE_MCP_CONFIRM_SECRET is required in production and must not use default"
      );
    } finally {
      authFile.cleanup();
    }
  });

  it("ORC-FX-029: startup fails when defaults.auto_target_project_ids includes unknown project", () => {
    const directory = mkdtempSync(join(tmpdir(), "appwrite-mcp-auth-invalid-auto-"));
    const filePath = join(directory, "project-auth.json");
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          default_endpoint: "https://example.appwrite.test/v1",
          projects: {
            P_A: {
              api_key: "sk_project_a",
              scopes: ["databases.write"]
            }
          },
          defaults: {
            auto_target_project_ids: ["P_UNKNOWN"]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    try {
      expect(() =>
        buildAppwriteControlService({
          argv: [],
          env: {
            APPWRITE_PROJECT_AUTH_FILE: filePath
          }
        })
      ).toThrow(
        "APPWRITE_PROJECT_AUTH_FILE defaults.auto_target_project_ids includes unknown project: P_UNKNOWN"
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("extra: unknown tool failure includes correlation_id", async () => {
    const authFile = createRuntimeAuthFile({
      P_DEFAULT: {
        api_key: "sk_test_key",
        scopes: ["databases.write"]
      }
    });
    const cwd = resolve(__dirname, "..");
    try {
      const child = spawn("./node_modules/.bin/tsx", ["src/index.ts"], {
        cwd,
        env: {
          ...process.env,
          APPWRITE_PROJECT_AUTH_FILE: authFile.filePath
        },
        stdio: ["pipe", "pipe", "pipe"]
      });

      const lines: string[] = [];
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        lines.push(...chunk.split("\n").filter((line) => line.trim().length > 0));
      });

      const unknownToolCall = {
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: {
          name: "unknown.tool",
          arguments: {}
        }
      };

      child.stdin.write(`${JSON.stringify(unknownToolCall)}\n`);
      child.stdin.end();

      await once(child, "exit");

      expect(lines.length).toBe(1);
      const payload = JSON.parse(lines[0]) as {
        result?: {
          content?: Array<{
            json?: {
              status?: string;
              correlation_id?: string;
              error?: { code?: string };
            };
          }>;
        };
      };

      const toolJson = payload.result?.content?.[0]?.json;
      expect(toolJson?.status).toBe("FAILED");
      expect(toolJson?.error?.code).toBe("VALIDATION_ERROR");
      expect(typeof toolJson?.correlation_id).toBe("string");
      expect((toolJson?.correlation_id?.length ?? 0) > 0).toBe(true);
    } finally {
      authFile.cleanup();
    }
  });

  it("extra: unresolved alias returns TARGET_NOT_FOUND", () => {
    const { service } = buildService({ aliasMap: { prod: "P_PROD" } });

    const preview = service.preview({
      actor: "tester",
      targets: [{ alias: "staging" }],
      operations: [baseOperation()]
    });

    if (!isMutationFailure(preview)) {
      throw new Error("expected alias resolution failure");
    }

    expect(preview.error.code).toBe("TARGET_NOT_FOUND");
  });

  it("extra: expired confirmation token is rejected", async () => {
    const { service, clock } = buildService({ projectManagementAvailable: true });

    const operation = baseOperation({
      operation_id: "op-project-delete",
      domain: "project",
      action: "project.delete",
      params: { project_id: "P_A" },
      required_scopes: ["projects.write"]
    });

    const preview = expectPreviewSuccess(
      service.preview({
        actor: "tester",
        targets: [{ project_id: "P_A" }],
        operations: [operation]
      })
    );

    const issue = service.issueConfirmationToken({
      plan_hash: preview.plan_hash,
      ttl_seconds: 30
    });

    if (isErrorResponse(issue)) {
      throw new Error("expected token issue success");
    }

    clock.advance(31);

    const apply = await service.apply({
      actor: "tester",
      targets: [{ project_id: "P_A" }],
      operations: [operation],
      plan_id: preview.plan_id,
      plan_hash: preview.plan_hash,
      confirmation_token: issue.token
    });

    expectApplyFailure(apply, "CONFIRM_REQUIRED");
  });
});
