import readline from "node:readline";
import type { AppwriteControlService } from "../core/appwrite-control-service.js";
import type {
  JsonRpcErrorObject,
  JsonRpcResponse
} from "./protocol.js";
import { isJsonRpcRequest } from "./protocol.js";
import { JsonRpcToolRouter } from "./jsonrpc-tool-router.js";

interface StdioJsonRpcServerOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  error?: NodeJS.WritableStream;
}

export class StdioJsonRpcServer {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly error: NodeJS.WritableStream;
  private readonly router: JsonRpcToolRouter;

  constructor(
    service: AppwriteControlService,
    options: StdioJsonRpcServerOptions = {}
  ) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.error = options.error ?? process.stderr;
    this.router = new JsonRpcToolRouter(service, {
      onFailure: (error) => {
        this.error.write(
          `[appwrite-mcp] request handling failure: ${String(error)}\n`
        );
      }
    });
  }

  start(): void {
    const rl = readline.createInterface({
      input: this.input,
      crlfDelay: Infinity
    });

    rl.on("line", (line) => {
      void this.onLine(line);
    });

    rl.on("close", () => {
      // stdin closed: server exits naturally.
    });
  }

  private async onLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      this.writeError({
        code: -32700,
        message: "Parse error"
      });
      return;
    }

    if (!isJsonRpcRequest(parsed)) {
      this.writeError({
        code: -32600,
        message: "Invalid Request"
      });
      return;
    }

    const response = await this.router.handle(parsed);
    this.write(response);
  }

  private write(response: JsonRpcResponse): void {
    this.output.write(`${JSON.stringify(response)}\n`);
  }

  private writeError(error: JsonRpcErrorObject): void {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: null,
      error
    };

    this.write(response);
  }
}
