import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAppwriteAdapter } from "../src/adapters/http-appwrite-adapter.js";
import type { AppwriteAdapterExecutionInput } from "../src/core/appwrite-adapter.js";

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

interface CaptureFetch {
  endpoint: string;
  getRequests: () => CapturedRequest[];
}

const startCaptureFetch = (): CaptureFetch => {
  const requests: CapturedRequest[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? ""
        : await request.text();

    requests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers.entries()),
      body
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });

  return {
    endpoint: "https://appwrite.test/v1",
    getRequests: () => [...requests]
  };
};

const buildInput = (
  endpoint: string,
  action: AppwriteAdapterExecutionInput["operation"]["action"],
  params: Record<string, unknown>
): AppwriteAdapterExecutionInput => ({
  target_project_id: "P_MAIN",
  operation: {
    operation_id: "op-1",
    domain: action.startsWith("database.")
      ? "database"
      : action.startsWith("auth.")
        ? "auth"
        : action.startsWith("project.")
          ? "project"
          : "function",
    action,
    params,
    required_scopes: ["databases.write"]
  },
  auth_context: {
    endpoint,
    api_key: "sk_test_key",
    scopes: ["databases.write", "users.write", "functions.write", "projects.write"]
  },
  correlation_id: "corr_test"
});

describe("HttpAppwriteAdapter contract", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("sends database.create with project-scoped headers", async () => {
    const adapter = new HttpAppwriteAdapter();
    const capture = startCaptureFetch();

    const result = await adapter.executeOperation(
      buildInput(capture.endpoint, "database.create", {
        database_id: "db-main",
        name: "Main Database"
      })
    );

    expect(result.ok).toBe(true);
    const requests = capture.getRequests();
    expect(requests).toHaveLength(1);

    const request = requests[0];
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v1/databases");
    expect(request.headers["x-appwrite-project"]).toBe("P_MAIN");
    expect(request.headers["x-appwrite-key"]).toBe("sk_test_key");
    expect(request.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(request.body) as { database_id?: string; name?: string };
    expect(body.database_id).toBe("db-main");
    expect(body.name).toBe("Main Database");
  });

  it("encodes auth.users.list query parameters correctly", async () => {
    const adapter = new HttpAppwriteAdapter();
    const capture = startCaptureFetch();

    const result = await adapter.executeOperation(
      buildInput(capture.endpoint, "auth.users.list", {
        limit: 20,
        search: "qa-user",
        active: true,
        ignored: { nested: true }
      })
    );

    expect(result.ok).toBe(true);
    const request = capture.getRequests()[0];

    expect(request.method).toBe("GET");
    expect(request.path.startsWith("/v1/users?")).toBe(true);

    const query = new URLSearchParams(request.path.split("?")[1]);
    expect(query.get("limit")).toBe("20");
    expect(query.get("search")).toBe("qa-user");
    expect(query.get("active")).toBe("true");
    expect(query.has("ignored")).toBe(false);
  });

  it("builds function.execution.status path with function and execution IDs", async () => {
    const adapter = new HttpAppwriteAdapter();
    const capture = startCaptureFetch();

    const result = await adapter.executeOperation(
      buildInput(capture.endpoint, "function.execution.status", {
        function_id: "fn_01",
        execution_id: "exec_02"
      })
    );

    expect(result.ok).toBe(true);
    const request = capture.getRequests()[0];
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/v1/functions/fn_01/executions/exec_02");
  });

  it("returns VALIDATION_ERROR when required params are missing", async () => {
    const adapter = new HttpAppwriteAdapter();
    const capture = startCaptureFetch();

    const result = await adapter.executeOperation(
      buildInput(capture.endpoint, "auth.users.update", {
        name: "No User ID"
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected validation failure");
    }

    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(capture.getRequests()).toHaveLength(0);
  });
});
