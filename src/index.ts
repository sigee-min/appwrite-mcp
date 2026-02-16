#!/usr/bin/env node

import {
  buildAppwriteControlService,
  resolveRuntimeServerConfig
} from "./config/runtime-config.js";
import { StdioJsonRpcServer } from "./mcp/stdio-jsonrpc-server.js";
import { StreamableHttpJsonRpcServer } from "./mcp/streamable-http-jsonrpc-server.js";

const main = async (): Promise<void> => {
  const runtimeInput = {
    argv: process.argv.slice(2),
    env: process.env
  };

  const service = buildAppwriteControlService(runtimeInput);
  const runtimeServerConfig = resolveRuntimeServerConfig(runtimeInput);

  if (runtimeServerConfig.transport === "streamable-http") {
    const server = new StreamableHttpJsonRpcServer(service, {
      host: runtimeServerConfig.streamableHttpHost,
      port: runtimeServerConfig.streamableHttpPort,
      path: runtimeServerConfig.streamableHttpPath
    });
    await server.start();
    return;
  }

  const server = new StdioJsonRpcServer(service);
  server.start();
};

void main().catch((error) => {
  const message =
    error instanceof Error ? error.message : "unknown startup error";
  process.stderr.write(`[appwrite-mcp] startup failure: ${message}\n`);
  process.exit(1);
});
