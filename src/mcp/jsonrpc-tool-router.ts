import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppwriteControlService } from "../core/appwrite-control-service.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./protocol.js";

const toolsCallParamsSchema = z.object({
  name: z.string(),
  arguments: z.unknown().optional()
});

interface JsonRpcToolRouterOptions {
  onFailure?: (error: unknown) => void;
}

export class JsonRpcToolRouter {
  constructor(
    private readonly service: AppwriteControlService,
    private readonly options: JsonRpcToolRouterOptions = {}
  ) {}

  async handle(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const requestId = request.id ?? null;

    try {
      switch (request.method) {
        case "initialize": {
          return {
            jsonrpc: "2.0",
            id: requestId,
            result: {
              protocolVersion: "2025-03-26",
              serverInfo: {
                name: "appwrite-mcp",
                version: "0.1.0"
              },
              capabilities: {
                tools: {}
              }
            }
          };
        }

        case "tools/list": {
          return {
            jsonrpc: "2.0",
            id: requestId,
            result: {
              tools: [
                {
                  name: "capabilities.list",
                  description: "List runtime capabilities and transport settings",
                  inputSchema: {
                    type: "object",
                    properties: {
                      transport: { type: "string" }
                    }
                  }
                },
                {
                  name: "context.get",
                  description: "Get runtime context for auto target resolution",
                  inputSchema: {
                    type: "object"
                  }
                },
                {
                  name: "targets.resolve",
                  description: "Resolve targets from explicit targets or selector",
                  inputSchema: {
                    type: "object"
                  }
                },
                {
                  name: "scopes.catalog.get",
                  description: "Return operation-to-scope catalog used by runtime",
                  inputSchema: {
                    type: "object"
                  }
                },
                {
                  name: "changes.preview",
                  description: "Preview Appwrite operations before apply",
                  inputSchema: {
                    type: "object"
                  }
                },
                {
                  name: "changes.apply",
                  description: "Apply Appwrite operations from a validated plan",
                  inputSchema: {
                    type: "object"
                  }
                },
                {
                  name: "confirm.issue",
                  description:
                    "Issue a confirmation token for critical destructive apply",
                  inputSchema: {
                    type: "object",
                    required: ["plan_hash"]
                  }
                }
              ]
            }
          };
        }

        case "tools/call": {
          const params = toolsCallParamsSchema.parse(request.params ?? {});
          const payload = await this.executeTool(params.name, params.arguments);

          return {
            jsonrpc: "2.0",
            id: requestId,
            result: {
              content: [
                {
                  type: "json",
                  json: payload
                }
              ]
            }
          };
        }

        default:
          return {
            jsonrpc: "2.0",
            id: requestId,
            error: {
              code: -32601,
              message: "Method not found"
            }
          };
      }
    } catch (error) {
      this.options.onFailure?.(error);

      return {
        jsonrpc: "2.0",
        id: requestId,
        error: {
          code: -32603,
          message: "Internal error"
        }
      };
    }
  }

  private async executeTool(name: string, args: unknown): Promise<unknown> {
    switch (name) {
      case "capabilities.list":
        return this.service.listCapabilities(args);
      case "context.get":
        return this.service.getRuntimeContext();
      case "targets.resolve":
        return this.service.resolveTargets(args);
      case "scopes.catalog.get":
        return this.service.getScopeCatalog();
      case "changes.preview":
        return this.service.preview(args);
      case "changes.apply":
        return this.service.apply(args);
      case "confirm.issue":
        return this.service.issueConfirmationToken(args);
      default:
        return this.buildFailedToolPayload(
          "VALIDATION_ERROR",
          `Unknown tool: ${name}`,
          "tool"
        );
    }
  }

  private buildFailedToolPayload(
    code: string,
    message: string,
    target: string
  ): Record<string, unknown> {
    return {
      correlation_id: `corr_${randomUUID()}`,
      status: "FAILED",
      summary: `${target} failed: ${code}`,
      error: {
        code,
        message,
        target,
        operation_id: "*",
        retryable: false
      }
    };
  }
}
