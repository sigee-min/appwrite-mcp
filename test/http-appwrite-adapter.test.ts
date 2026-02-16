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

  it("maps database.list to GET /databases with query passthrough", async () => {
    const adapter = new HttpAppwriteAdapter();
    const capture = startCaptureFetch();

    const result = await adapter.executeOperation(
      buildInput(capture.endpoint, "database.list", {
        limit: 5,
        search: "main"
      })
    );

    expect(result.ok).toBe(true);
    const request = capture.getRequests()[0];
    expect(request?.method).toBe("GET");
    expect(request?.path.startsWith("/v1/databases?")).toBe(true);
    const query = new URLSearchParams((request?.path ?? "").split("?")[1]);
    expect(query.get("limit")).toBe("5");
    expect(query.get("search")).toBe("main");
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

  it("maps function.list to GET /functions", async () => {
    const adapter = new HttpAppwriteAdapter();
    const capture = startCaptureFetch();

    const result = await adapter.executeOperation(
      buildInput(capture.endpoint, "function.list", {
        limit: 3,
        search: "worker"
      })
    );

    expect(result.ok).toBe(true);
    const request = capture.getRequests()[0];
    expect(request?.method).toBe("GET");
    expect(request?.path.startsWith("/v1/functions?")).toBe(true);
    const query = new URLSearchParams((request?.path ?? "").split("?")[1]);
    expect(query.get("limit")).toBe("3");
    expect(query.get("search")).toBe("worker");
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

  it("maps auth.users.update name update to /users/{id}/name", async () => {
    const adapter = new HttpAppwriteAdapter();
    const capture = startCaptureFetch();

    const result = await adapter.executeOperation(
      buildInput(capture.endpoint, "auth.users.update", {
        user_id: "u_01",
        name: "Updated User"
      })
    );

    expect(result.ok).toBe(true);
    const request = capture.getRequests()[0];
    expect(request?.method).toBe("PATCH");
    expect(request?.path).toBe("/v1/users/u_01/name");

    const body = JSON.parse(request?.body ?? "{}") as { name?: string };
    expect(body.name).toBe("Updated User");
  });

  it("sends function.deployment.trigger as multipart form-data", async () => {
    const adapter = new HttpAppwriteAdapter();
    const capture = startCaptureFetch();

    const result = await adapter.executeOperation(
      buildInput(capture.endpoint, "function.deployment.trigger", {
        function_id: "fn_01",
        code: "bundle-content",
        activate: true,
        entrypoint: "src/main.ts",
        commands: "npm run build"
      })
    );

    expect(result.ok).toBe(true);
    const request = capture.getRequests()[0];
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/v1/functions/fn_01/deployments");
    expect(request?.headers["content-type"]).toContain("multipart/form-data");
    expect(request?.body).toContain("name=\"code\"");
    expect(request?.body).toContain("name=\"activate\"");
  });

  it("omits X-Appwrite-Project header for project.create", async () => {
    const adapter = new HttpAppwriteAdapter();
    const capture = startCaptureFetch();

    const result = await adapter.executeOperation(
      buildInput(capture.endpoint, "project.create", {
        projectId: "proj_01",
        teamId: "team_01",
        name: "Project One"
      })
    );

    expect(result.ok).toBe(true);
    const request = capture.getRequests()[0];
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/v1/projects");
    expect(request?.headers["x-appwrite-project"]).toBeUndefined();
  });

  it("maps explicit auth.users.update.email action to /users/{id}/email", async () => {
    const adapter = new HttpAppwriteAdapter();
    const capture = startCaptureFetch();

    const result = await adapter.executeOperation(
      buildInput(capture.endpoint, "auth.users.update.email", {
        user_id: "u_01",
        email: "updated@example.com"
      })
    );

    expect(result.ok).toBe(true);
    const request = capture.getRequests()[0];
    expect(request?.method).toBe("PATCH");
    expect(request?.path).toBe("/v1/users/u_01/email");
  });

  it("validates project.create required fields before request", async () => {
    const adapter = new HttpAppwriteAdapter();
    const capture = startCaptureFetch();

    const result = await adapter.executeOperation(
      buildInput(capture.endpoint, "project.create", {
        projectId: "proj_01",
        name: "Project One"
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected project create validation failure");
    }
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(capture.getRequests()).toHaveLength(0);
  });

  it("validates deployment trigger code before multipart upload", async () => {
    const adapter = new HttpAppwriteAdapter();
    const capture = startCaptureFetch();

    const result = await adapter.executeOperation(
      buildInput(capture.endpoint, "function.deployment.trigger", {
        function_id: "fn_01"
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected deployment validation failure");
    }
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(capture.getRequests()).toHaveLength(0);
  });

  it("retries GET requests on retryable status and eventually succeeds", async () => {
    let attempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ message: "busy" }), {
          status: 503,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const adapter = new HttpAppwriteAdapter({
      maxRetries: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
      timeoutMs: 200
    });

    const result = await adapter.executeOperation(
      buildInput("https://appwrite.test/v1", "auth.users.list", { limit: 1 })
    );

    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  it("does not retry non-idempotent POST by default", async () => {
    let attempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts += 1;
      return new Response(JSON.stringify({ message: "server error" }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    });

    const adapter = new HttpAppwriteAdapter({
      maxRetries: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
      timeoutMs: 200
    });

    const result = await adapter.executeOperation(
      buildInput("https://appwrite.test/v1", "database.create", {
        database_id: "db_1",
        name: "db"
      })
    );

    expect(result.ok).toBe(false);
    expect(attempts).toBe(1);
  });

  it("retries POST when idempotency_key is present", async () => {
    let attempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ message: "temporary" }), {
          status: 503,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const adapter = new HttpAppwriteAdapter({
      maxRetries: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
      timeoutMs: 200
    });

    const input = buildInput("https://appwrite.test/v1", "database.create", {
      database_id: "db_1",
      name: "db"
    });
    input.operation.idempotency_key = "idem-db-create";

    const result = await adapter.executeOperation(input);

    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  it("marks timeout-like abort as retryable error", async () => {
    let attempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts += 1;
      const error = new Error("aborted");
      (error as Error & { name: string }).name = "AbortError";
      throw error;
    });

    const adapter = new HttpAppwriteAdapter({
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
      timeoutMs: 5
    });

    const result = await adapter.executeOperation(
      buildInput("https://appwrite.test/v1", "auth.users.list", { limit: 1 })
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected timeout-like failure");
    }
    expect(result.error.retryable).toBe(true);
    expect(attempts).toBe(2);
  });
});
