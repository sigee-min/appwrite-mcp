import { describe, expect, it } from "vitest";
import { resolveRuntimeServerConfig } from "../src/config/runtime-config.js";

describe("runtime server config", () => {
  it("defaults to stdio with default streamable-http bind values", () => {
    const config = resolveRuntimeServerConfig({
      argv: [],
      env: {}
    });

    expect(config.transport).toBe("stdio");
    expect(config.streamableHttpHost).toBe("127.0.0.1");
    expect(config.streamableHttpPort).toBe(8080);
    expect(config.streamableHttpPath).toBe("/mcp");
  });

  it("fails when streamable-http transport is requested without enable flag", () => {
    expect(() =>
      resolveRuntimeServerConfig({
        argv: ["--transport=streamable-http"],
        env: {}
      })
    ).toThrowError(
      "streamable-http transport requires APPWRITE_MCP_ENABLE_STREAMABLE_HTTP=true"
    );
  });

  it("parses streamable-http config from environment", () => {
    const config = resolveRuntimeServerConfig({
      argv: [],
      env: {
        APPWRITE_MCP_TRANSPORT: "streamable-http",
        APPWRITE_MCP_ENABLE_STREAMABLE_HTTP: "true",
        APPWRITE_MCP_HTTP_HOST: "0.0.0.0",
        APPWRITE_MCP_HTTP_PORT: "9090",
        APPWRITE_MCP_HTTP_PATH: "/rpc",
        APPWRITE_MCP_ALLOW_REMOTE_HTTP: "true"
      }
    });

    expect(config.transport).toBe("streamable-http");
    expect(config.streamableHttpHost).toBe("0.0.0.0");
    expect(config.streamableHttpPort).toBe(9090);
    expect(config.streamableHttpPath).toBe("/rpc");
  });

  it("fails on unsupported transport value", () => {
    expect(() =>
      resolveRuntimeServerConfig({
        argv: [],
        env: {
          APPWRITE_MCP_TRANSPORT: "invalid-transport"
        }
      })
    ).toThrowError("Unsupported startup transport: invalid-transport");
  });

  it("fails on invalid http port value", () => {
    expect(() =>
      resolveRuntimeServerConfig({
        argv: [],
        env: {
          APPWRITE_MCP_HTTP_PORT: "abc"
        }
      })
    ).toThrowError(
      "APPWRITE_MCP_HTTP_PORT must be an integer between 1 and 65535"
    );
  });

  it("uses argv transport over environment transport", () => {
    const config = resolveRuntimeServerConfig({
      argv: ["--transport=stdio"],
      env: {
        APPWRITE_MCP_TRANSPORT: "streamable-http",
        APPWRITE_MCP_ENABLE_STREAMABLE_HTTP: "true"
      }
    });

    expect(config.transport).toBe("stdio");
  });

  it("fails on remote streamable-http host unless explicitly allowed", () => {
    expect(() =>
      resolveRuntimeServerConfig({
        argv: [],
        env: {
          APPWRITE_MCP_TRANSPORT: "streamable-http",
          APPWRITE_MCP_ENABLE_STREAMABLE_HTTP: "true",
          APPWRITE_MCP_HTTP_HOST: "0.0.0.0"
        }
      })
    ).toThrowError(
      "remote streamable-http host requires APPWRITE_MCP_ALLOW_REMOTE_HTTP=true"
    );
  });

  it("allows remote streamable-http host with explicit allow flag", () => {
    const config = resolveRuntimeServerConfig({
      argv: [],
      env: {
        APPWRITE_MCP_TRANSPORT: "streamable-http",
        APPWRITE_MCP_ENABLE_STREAMABLE_HTTP: "true",
        APPWRITE_MCP_HTTP_HOST: "0.0.0.0",
        APPWRITE_MCP_ALLOW_REMOTE_HTTP: "true"
      }
    });

    expect(config.transport).toBe("streamable-http");
    expect(config.streamableHttpHost).toBe("0.0.0.0");
  });
});
