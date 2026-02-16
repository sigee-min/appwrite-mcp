import { describe, expect, it } from "vitest";
import { buildAppwriteControlService } from "../src/config/runtime-config.js";

const runLiveE2E = process.env.APPWRITE_MCP_ENABLE_LIVE_E2E === "true";
const runExtendedLiveReadE2E =
  process.env.APPWRITE_MCP_ENABLE_LIVE_EXTENDED_READ_E2E === "true";

describe.runIf(runLiveE2E)("Live Appwrite preview/apply/confirm e2e", () => {
  it("runs preview/apply and issues confirmation token", async () => {
    const targetProjectId = process.env.APPWRITE_LIVE_TARGET_PROJECT_ID;
    if (!targetProjectId) {
      throw new Error("APPWRITE_LIVE_TARGET_PROJECT_ID is required for live e2e");
    }

    const service = buildAppwriteControlService({
      argv: [],
      env: process.env
    });

    const preview = service.preview({
      actor: "live-e2e",
      targets: [{ project_id: targetProjectId }],
      operations: [
        {
          operation_id: "live-op-users-list",
          domain: "auth",
          action: "auth.users.list",
          params: { limit: 1 }
        }
      ]
    });

    if ("error" in preview) {
      throw new Error(`live preview failed: ${preview.error.code}`);
    }

    const apply = await service.apply({
      actor: "live-e2e",
      targets: [{ project_id: targetProjectId }],
      operations: [
        {
          operation_id: "live-op-users-list",
          domain: "auth",
          action: "auth.users.list",
          params: { limit: 1 }
        }
      ],
      plan_id: preview.plan_id,
      plan_hash: preview.plan_hash
    });

    expect(apply.status === "SUCCESS" || apply.status === "PARTIAL_SUCCESS").toBe(true);

    const issue = service.issueConfirmationToken({
      plan_hash: preview.plan_hash,
      ttl_seconds: 60
    });

    expect(issue.status).toBe("SUCCESS");
  });
});

describe.runIf(runExtendedLiveReadE2E)(
  "Live Appwrite extended read-only e2e",
  () => {
    it("runs read-only auth/database/function actions without mutation", async () => {
      const targetProjectId = process.env.APPWRITE_LIVE_TARGET_PROJECT_ID;
      if (!targetProjectId) {
        throw new Error(
          "APPWRITE_LIVE_TARGET_PROJECT_ID is required for live extended read e2e"
        );
      }

      const service = buildAppwriteControlService({
        argv: [],
        env: process.env
      });

      const operations = [
        {
          operation_id: "live-op-users-list",
          domain: "auth" as const,
          action: "auth.users.list" as const,
          params: { limit: 1 }
        },
        {
          operation_id: "live-op-database-list",
          domain: "database" as const,
          action: "database.list" as const,
          params: { limit: 1 }
        },
        {
          operation_id: "live-op-function-list",
          domain: "function" as const,
          action: "function.list" as const,
          params: { limit: 1 }
        }
      ];

      const preview = service.preview({
        actor: "live-e2e-extended",
        targets: [{ project_id: targetProjectId }],
        operations
      });

      if ("error" in preview) {
        throw new Error(`live extended preview failed: ${preview.error.code}`);
      }

      const apply = await service.apply({
        actor: "live-e2e-extended",
        targets: [{ project_id: targetProjectId }],
        operations,
        plan_id: preview.plan_id,
        plan_hash: preview.plan_hash
      });

      if ("error" in apply) {
        throw new Error(`live extended apply failed: ${apply.error.code}`);
      }

      expect(apply.status === "SUCCESS" || apply.status === "PARTIAL_SUCCESS").toBe(
        true
      );
      expect(apply.target_results).toHaveLength(1);
      const operationIds =
        apply.target_results[0]?.operations.map((operation) => operation.operation_id) ??
        [];
      expect(operationIds).toEqual([
        "live-op-users-list",
        "live-op-database-list",
        "live-op-function-list"
      ]);
    });
  }
);
