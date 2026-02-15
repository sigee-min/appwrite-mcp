import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppwriteControlService } from "../core/appwrite-control-service.js";
import type { JsonRpcErrorObject, JsonRpcResponse } from "./protocol.js";
import { isJsonRpcRequest } from "./protocol.js";
import { JsonRpcToolRouter } from "./jsonrpc-tool-router.js";

const MAX_BODY_BYTES = 1_048_576;

interface StreamableHttpJsonRpcServerOptions {
  host?: string;
  port?: number;
  path?: string;
  error?: NodeJS.WritableStream;
}

export interface StreamableHttpEndpoint {
  host: string;
  port: number;
  path: string;
  url: string;
}

export class StreamableHttpJsonRpcServer {
  private readonly host: string;
  private readonly port: number;
  private readonly path: string;
  private readonly error: NodeJS.WritableStream;
  private readonly router: JsonRpcToolRouter;
  private server?: Server;

  constructor(
    service: AppwriteControlService,
    options: StreamableHttpJsonRpcServerOptions = {}
  ) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 8080;
    this.path = this.normalizePath(options.path ?? "/mcp");
    this.error = options.error ?? process.stderr;
    this.router = new JsonRpcToolRouter(service, {
      onFailure: (error) => {
        this.error.write(
          `[appwrite-mcp] streamable-http request handling failure: ${String(error)}\n`
        );
      }
    });
  }

  async start(): Promise<StreamableHttpEndpoint> {
    if (this.server) {
      return this.getEndpoint();
    }

    this.server = createServer((request, response) => {
      void this.onRequest(request, response);
    });

    return await new Promise<StreamableHttpEndpoint>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error("streamable-http server initialization failed"));
        return;
      }

      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };

      const onListening = () => {
        server.off("error", onError);
        const endpoint = this.getEndpoint();
        this.error.write(
          `[appwrite-mcp] streamable-http listening on ${endpoint.url}\n`
        );
        resolve(endpoint);
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.port, this.host);
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;

    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private async onRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const requestPath = this.getRequestPath(request);

    if (requestPath !== this.path) {
      this.writeHttpError(response, 404, "Not Found");
      return;
    }

    if (request.method !== "POST") {
      this.writeHttpError(response, 405, "Method Not Allowed", {
        Allow: "POST"
      });
      return;
    }

    let body: string;
    try {
      body = await this.readBody(request);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "request body read failed";
      if (message === "REQUEST_BODY_TOO_LARGE") {
        this.writeHttpError(response, 413, "Payload Too Large");
        return;
      }

      this.error.write(
        `[appwrite-mcp] streamable-http request body failure: ${message}\n`
      );
      this.writeJsonRpcError(
        response,
        {
          code: -32603,
          message: "Internal error"
        },
        500
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      this.writeJsonRpcError(
        response,
        {
          code: -32700,
          message: "Parse error"
        },
        400
      );
      return;
    }

    if (!isJsonRpcRequest(parsed)) {
      this.writeJsonRpcError(
        response,
        {
          code: -32600,
          message: "Invalid Request"
        },
        400
      );
      return;
    }

    const rpcResponse = await this.router.handle(parsed);
    this.writeJson(response, rpcResponse, 200);
  }

  private async readBody(request: IncomingMessage): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let bytes = 0;
      const chunks: Buffer[] = [];

      request.on("data", (chunk: Buffer | string) => {
        if (settled) {
          return;
        }

        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        bytes += buffer.length;
        if (bytes > MAX_BODY_BYTES) {
          settled = true;
          reject(new Error("REQUEST_BODY_TOO_LARGE"));
          request.destroy();
          return;
        }

        chunks.push(buffer);
      });

      request.on("end", () => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      });

      request.on("error", (error) => {
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      });
    });
  }

  private getRequestPath(request: IncomingMessage): string {
    const requestUrl = request.url ?? "/";
    try {
      const host = request.headers.host ?? `${this.host}:${this.port}`;
      const parsed = new URL(requestUrl, `http://${host}`);
      return this.normalizePath(parsed.pathname);
    } catch {
      return "/";
    }
  }

  private writeJson(
    response: ServerResponse,
    payload: JsonRpcResponse,
    statusCode: number
  ): void {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
  }

  private writeJsonRpcError(
    response: ServerResponse,
    error: JsonRpcErrorObject,
    statusCode: number
  ): void {
    this.writeJson(
      response,
      {
        jsonrpc: "2.0",
        id: null,
        error
      },
      statusCode
    );
  }

  private writeHttpError(
    response: ServerResponse,
    statusCode: number,
    message: string,
    headers: Record<string, string> = {}
  ): void {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    for (const [key, value] of Object.entries(headers)) {
      response.setHeader(key, value);
    }
    response.end(JSON.stringify({ error: message }));
  }

  private normalizePath(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === "/") {
      return "/";
    }

    const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    return withLeadingSlash.endsWith("/")
      ? withLeadingSlash.slice(0, -1)
      : withLeadingSlash;
  }

  private getEndpoint(): StreamableHttpEndpoint {
    const serverAddress = this.server?.address();
    if (!serverAddress || typeof serverAddress === "string") {
      return {
        host: this.host,
        port: this.port,
        path: this.path,
        url: `http://${this.host}:${this.port}${this.path}`
      };
    }

    const addressInfo = serverAddress as AddressInfo;
    const host =
      addressInfo.address === "::" ? "127.0.0.1" : addressInfo.address;

    return {
      host,
      port: addressInfo.port,
      path: this.path,
      url: `http://${host}:${addressInfo.port}${this.path}`
    };
  }
}
