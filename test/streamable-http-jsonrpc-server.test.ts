import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAppwriteControlService } from "../src/config/runtime-config.js";
import { StreamableHttpJsonRpcServer } from "../src/mcp/streamable-http-jsonrpc-server.js";

interface TempAuthFile {
  filePath: string;
  cleanup: () => void;
}

const createAuthFile = (): TempAuthFile => {
  const directory = mkdtempSync(join(tmpdir(), "streamable-http-test-"));
  const filePath = join(directory, "project-auth.json");

  writeFileSync(
    filePath,
    JSON.stringify(
      {
        default_endpoint: "https://example.appwrite.test/v1",
        projects: {
          P_A: {
            api_key: "sk_test_a",
            scopes: ["users.read", "users.write"]
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
    cleanup: () => {
      rmSync(directory, { recursive: true, force: true });
    }
  };
};

describe("StreamableHttpJsonRpcServer", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      cleanup?.();
    }
  });

  it("handles initialize and tools/call over HTTP", async () => {
    const authFile = createAuthFile();
    cleanups.push(authFile.cleanup);

    const service = buildAppwriteControlService({
      argv: [],
      env: {
        APPWRITE_PROJECT_AUTH_FILE: authFile.filePath,
        APPWRITE_MCP_ENABLE_STREAMABLE_HTTP: "true"
      }
    });

    const server = new StreamableHttpJsonRpcServer(service, {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp"
    });

    try {
      const endpoint = await server.start();

      const initializeResponse = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {}
        })
      });

      expect(initializeResponse.status).toBe(200);
      const initializePayload = (await initializeResponse.json()) as {
        result?: {
          protocolVersion?: string;
          serverInfo?: {
            name?: string;
          };
        };
      };

      expect(initializePayload.result?.protocolVersion).toBe("2025-03-26");
      expect(initializePayload.result?.serverInfo?.name).toBe("appwrite-mcp");

      const capabilityResponse = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "capabilities.list",
            arguments: {}
          }
        })
      });

      expect(capabilityResponse.status).toBe(200);
      const capabilityPayload = (await capabilityResponse.json()) as {
        result?: {
          content?: Array<{
            json?: {
              capabilities?: {
                transport_default?: string;
                supported_transports?: string[];
              };
            };
          }>;
        };
      };

      const capabilities = capabilityPayload.result?.content?.[0]?.json?.capabilities;
      expect(capabilities?.transport_default).toBe("stdio");
      expect(capabilities?.supported_transports).toContain("streamable-http");

      const toolsResponse = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list",
          params: {}
        })
      });

      expect(toolsResponse.status).toBe(200);
      const toolsPayload = (await toolsResponse.json()) as {
        result?: {
          tools?: Array<{ name?: string }>;
        };
      };
      const toolNames = (toolsPayload.result?.tools ?? []).map((tool) => tool.name);
      expect(toolNames).toContain("context.get");
      expect(toolNames).toContain("targets.resolve");
      expect(toolNames).toContain("scopes.catalog.get");
    } finally {
      await server.stop();
    }
  });

  it("returns JSON-RPC parse error for invalid JSON payload", async () => {
    const authFile = createAuthFile();
    cleanups.push(authFile.cleanup);

    const service = buildAppwriteControlService({
      argv: [],
      env: {
        APPWRITE_PROJECT_AUTH_FILE: authFile.filePath,
        APPWRITE_MCP_ENABLE_STREAMABLE_HTTP: "true"
      }
    });

    const server = new StreamableHttpJsonRpcServer(service, {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp"
    });

    try {
      const endpoint = await server.start();

      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: "{invalid-json"
      });

      expect(response.status).toBe(400);
      const payload = (await response.json()) as {
        error?: {
          code?: number;
        };
      };

      expect(payload.error?.code).toBe(-32700);
    } finally {
      await server.stop();
    }
  });

  it("returns method-not-found for unknown JSON-RPC method", async () => {
    const authFile = createAuthFile();
    cleanups.push(authFile.cleanup);

    const service = buildAppwriteControlService({
      argv: [],
      env: {
        APPWRITE_PROJECT_AUTH_FILE: authFile.filePath,
        APPWRITE_MCP_ENABLE_STREAMABLE_HTTP: "true"
      }
    });

    const server = new StreamableHttpJsonRpcServer(service, {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp"
    });

    try {
      const endpoint = await server.start();

      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 11,
          method: "unknown.method",
          params: {}
        })
      });

      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        error?: { code?: number; message?: string };
      };

      expect(payload.error?.code).toBe(-32601);
      expect(payload.error?.message).toBe("Method not found");
    } finally {
      await server.stop();
    }
  });
});
