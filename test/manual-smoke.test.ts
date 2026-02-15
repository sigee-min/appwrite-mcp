import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ApplyResponse,
  MutationErrorResponse,
  PreviewResponse
} from "../src/domain/types.js";
import {
  parseManualSmokeConfig,
  runManualSmokeSuite
} from "../src/e2e/manual-smoke.js";

interface FakeSmokeService {
  preview(input: unknown): PreviewResponse | MutationErrorResponse;
  apply(input: unknown): Promise<ApplyResponse | MutationErrorResponse>;
}

const buildPreviewSuccess = (id: string): PreviewResponse => ({
  correlation_id: `corr-${id}`,
  mode: "preview",
  status: "SUCCESS",
  plan_id: `plan-${id}`,
  plan_hash: `hash-${id}`,
  target_projects: ["P_A", "P_B"],
  operations: [],
  destructive_count: 0,
  risk_level: "LOW",
  required_scopes: [],
  summary: "ok"
});

const createAuthFile = (): { filePath: string; cleanup: () => void } => {
  const directory = mkdtempSync(join(tmpdir(), "manual-smoke-test-"));
  const filePath = join(directory, "auth.json");
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        default_endpoint: "https://example.appwrite.test/v1",
        projects: {
          P_A: {
            api_key: "sk_a",
            scopes: ["users.read", "users.write"]
          },
          P_B: {
            api_key: "sk_b",
            scopes: ["users.read"]
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  return {
    filePath,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
};

describe("manual smoke suite", () => {
  it("parses config and enforces minimum target count", () => {
    const auth = createAuthFile();
    try {
      const config = parseManualSmokeConfig({
        APPWRITE_PROJECT_AUTH_FILE: auth.filePath,
        APPWRITE_SMOKE_TARGETS: "P_A,P_B"
      });

      expect(config.targets).toHaveLength(2);
      expect(config.executionPolicy).toBe("manual");
      expect(config.cases).toHaveLength(3);
    } finally {
      auth.cleanup();
    }
  });

  it("fails parsing when targets are missing", () => {
    const auth = createAuthFile();
    expect(() =>
      parseManualSmokeConfig({
        APPWRITE_PROJECT_AUTH_FILE: auth.filePath
      })
    ).toThrowError("APPWRITE_SMOKE_TARGETS is required");
    auth.cleanup();
  });

  it("builds PASS report when statuses match expected cases", async () => {
    const service: FakeSmokeService = {
      preview: (input) => {
        const typed = input as {
          operations: Array<{ required_scopes?: string[] }>;
        };
        const requiredScope = typed.operations[0]?.required_scopes?.[0];
        if (requiredScope === "users.read") {
          return buildPreviewSuccess("case1");
        }
        if (requiredScope === "users.write") {
          return buildPreviewSuccess("case2");
        }
        return buildPreviewSuccess("case3");
      },
      apply: async (input) => {
        const typed = input as { plan_id: string };

        if (typed.plan_id === "plan-case1") {
          return {
            correlation_id: "apply-1",
            mode: "apply",
            status: "SUCCESS",
            plan_id: "plan-case1",
            plan_hash: "hash-case1",
            target_results: [
              {
                target: { project_id: "P_A" },
                project_id: "P_A",
                status: "SUCCESS",
                operations: [{ operation_id: "op", status: "SUCCESS", data: {} }]
              },
              {
                target: { project_id: "P_B" },
                project_id: "P_B",
                status: "SUCCESS",
                operations: [{ operation_id: "op", status: "SUCCESS", data: {} }]
              }
            ],
            destructive_count: 0,
            risk_level: "LOW",
            summary: "ok"
          };
        }

        if (typed.plan_id === "plan-case2") {
          return {
            correlation_id: "apply-2",
            mode: "apply",
            status: "PARTIAL_SUCCESS",
            plan_id: "plan-case2",
            plan_hash: "hash-case2",
            target_results: [
              {
                target: { project_id: "P_A" },
                project_id: "P_A",
                status: "SUCCESS",
                operations: [{ operation_id: "op", status: "SUCCESS", data: {} }]
              },
              {
                target: { project_id: "P_B" },
                project_id: "P_B",
                status: "FAILED",
                operations: [
                  {
                    operation_id: "op",
                    status: "FAILED",
                    error: {
                      code: "MISSING_SCOPE",
                      message: "missing",
                      target: "P_B",
                      operation_id: "op",
                      retryable: false
                    }
                  }
                ]
              }
            ],
            destructive_count: 0,
            risk_level: "LOW",
            summary: "partial"
          };
        }

        return {
          correlation_id: "apply-3",
          mode: "apply",
          status: "FAILED",
          summary: "failed",
          error: {
            code: "MISSING_SCOPE",
            message: "missing scopes",
            target: "P_A",
            operation_id: "op",
            retryable: false
          }
        };
      }
    };

    const config = {
      actor: "tester",
      endpoint: "https://example.appwrite.test/v1",
      executionPolicy: "manual" as const,
      targets: [{ projectId: "P_A" }, { projectId: "P_B" }],
      cases: [
        {
          id: "CASE-01" as const,
          name: "success",
          expectedStatus: "SUCCESS" as const,
          requiredScope: "users.read",
          params: {}
        },
        {
          id: "CASE-02" as const,
          name: "partial",
          expectedStatus: "PARTIAL_SUCCESS" as const,
          requiredScope: "users.write",
          params: {}
        },
        {
          id: "CASE-03" as const,
          name: "auth-fail",
          expectedStatus: "FAILED" as const,
          requiredScope: "__missing_scope__",
          params: {}
        }
      ]
    };

    const report = await runManualSmokeSuite(service, config);

    expect(report.summary.total).toBe(3);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.overall).toBe("PASS");
  });

  it("records preview failure as failed case", async () => {
    const service: FakeSmokeService = {
      preview: () => ({
        correlation_id: "corr-preview-fail",
        mode: "preview",
        status: "FAILED",
        summary: "invalid",
        error: {
          code: "VALIDATION_ERROR",
          message: "invalid",
          target: "preview",
          operation_id: "preview",
          retryable: false
        }
      }),
      apply: async () => {
        throw new Error("should not be called");
      }
    };

    const report = await runManualSmokeSuite(service, {
      actor: "tester",
      endpoint: "https://example.appwrite.test/v1",
      executionPolicy: "manual",
      targets: [{ projectId: "P_A" }, { projectId: "P_B" }],
      cases: [
        {
          id: "CASE-01",
          name: "success",
          expectedStatus: "SUCCESS",
          requiredScope: "users.read",
          params: {}
        }
      ]
    });

    expect(report.summary.overall).toBe("FAIL");
    expect(report.cases[0]?.observed_status).toBe("PREVIEW_FAILED");
  });
});
