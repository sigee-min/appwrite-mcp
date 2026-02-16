import { describe, expect, it } from "vitest";

interface OpenApiSpec {
  paths: Record<string, Record<string, { requestBody?: { content?: Record<string, unknown> } }>>;
}

const runOnlineContractCheck =
  process.env.APPWRITE_MCP_ONLINE_OPENAPI_CONTRACT === "true";

const loadSpec = async (name: string): Promise<OpenApiSpec> => {
  const response = await fetch(
    `https://raw.githubusercontent.com/appwrite/appwrite/master/app/config/specs/${name}`
  );
  if (!response.ok) {
    throw new Error(`failed to fetch ${name}: ${response.status}`);
  }

  return (await response.json()) as OpenApiSpec;
};

describe.runIf(runOnlineContractCheck)("Appwrite OpenAPI contract guard", () => {
  it("contains expected endpoint/method pairs for supported actions", async () => {
    const [serverSpec, consoleSpec] = await Promise.all([
      loadSpec("open-api3-1.8.x-server.json"),
      loadSpec("open-api3-1.8.x-console.json")
    ]);

    const required = [
      ["server", "/databases", "get"],
      ["server", "/databases", "post"],
      ["server", "/databases/{databaseId}/collections", "post"],
      ["server", "/databases/{databaseId}/collections/{collectionId}", "put"],
      ["server", "/databases/{databaseId}/collections/{collectionId}", "delete"],
      ["server", "/users", "get"],
      ["server", "/users", "post"],
      ["server", "/users/{userId}/name", "patch"],
      ["server", "/users/{userId}/email", "patch"],
      ["server", "/users/{userId}/status", "patch"],
      ["server", "/users/{userId}/password", "patch"],
      ["server", "/users/{userId}/phone", "patch"],
      ["server", "/users/{userId}/verification", "patch"],
      ["server", "/users/{userId}/verification/phone", "patch"],
      ["server", "/users/{userId}/mfa", "patch"],
      ["server", "/users/{userId}/labels", "put"],
      ["server", "/users/{userId}/prefs", "patch"],
      ["server", "/functions", "get"],
      ["server", "/functions", "post"],
      ["server", "/functions/{functionId}", "put"],
      ["server", "/functions/{functionId}/deployments", "post"],
      ["server", "/functions/{functionId}/executions", "post"],
      ["server", "/functions/{functionId}/executions/{executionId}", "get"],
      ["console", "/projects", "post"],
      ["console", "/projects/{projectId}", "delete"]
    ] as const;

    for (const [scope, path, method] of required) {
      const spec = scope === "server" ? serverSpec : consoleSpec;
      expect(spec.paths[path]?.[method]).toBeTruthy();
    }
  });

  it("keeps function deployment content-type multipart/form-data", async () => {
    const serverSpec = await loadSpec("open-api3-1.8.x-server.json");
    const deploymentPost = serverSpec.paths["/functions/{functionId}/deployments"]?.post;
    const content = deploymentPost?.requestBody?.content ?? {};

    expect(Object.keys(content)).toContain("multipart/form-data");
  });
});
