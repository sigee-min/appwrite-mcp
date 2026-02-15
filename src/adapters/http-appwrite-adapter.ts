import { AppwriteMcpError, toStandardError } from "../domain/errors.js";
import type {
  MutationOperation,
  OperationAction,
  StandardError
} from "../domain/types.js";
import type {
  AdapterExecutionResult,
  AppwriteAdapter,
  AppwriteAdapterExecutionInput
} from "../core/appwrite-adapter.js";

interface HttpOperationRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string | number | boolean>;
}

export class HttpAppwriteAdapter implements AppwriteAdapter {
  async executeOperation(
    input: AppwriteAdapterExecutionInput
  ): Promise<AdapterExecutionResult> {
    try {
      if (!input.auth_context.endpoint || !input.auth_context.api_key) {
        return {
          ok: false,
          error: {
            code: "AUTH_CONTEXT_REQUIRED",
            message: "missing endpoint/api key in auth context",
            target: input.target_project_id,
            operation_id: input.operation.operation_id,
            retryable: false
          }
        };
      }

      const request = this.buildRequest(input.operation);
      const response = await this.performHttpRequest(input, request);
      return response;
    } catch (error) {
      if (error instanceof AppwriteMcpError) {
        return {
          ok: false,
          error: toStandardError(error)
        };
      }

      return {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "unexpected adapter error",
          target: input.target_project_id,
          operation_id: input.operation.operation_id,
          retryable: true
        }
      };
    }
  }

  private async performHttpRequest(
    input: AppwriteAdapterExecutionInput,
    request: HttpOperationRequest
  ): Promise<AdapterExecutionResult> {
    const baseUrl = input.auth_context.endpoint;
    if (!baseUrl) {
      return {
        ok: false,
        error: {
          code: "AUTH_CONTEXT_REQUIRED",
          message: "missing endpoint in auth context",
          target: input.target_project_id,
          operation_id: input.operation.operation_id,
          retryable: false
        }
      };
    }

    const url = new URL(
      request.path,
      baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
    );

    if (request.query) {
      for (const [key, value] of Object.entries(request.query)) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Appwrite-Key": input.auth_context.api_key ?? "",
      "X-Appwrite-Project": input.target_project_id,
      "X-Appwrite-Response-Format": "1.8.0"
    };

    const response = await fetch(url, {
      method: request.method,
      headers,
      body: request.body ? JSON.stringify(request.body) : undefined
    });

    const textBody = await response.text();
    const parsedBody = this.parseBody(textBody);

    if (!response.ok) {
      const message = this.extractErrorMessage(parsedBody, response.status);
      return {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message,
          target: input.target_project_id,
          operation_id: input.operation.operation_id,
          retryable: response.status >= 500
        }
      };
    }

    if (parsedBody && typeof parsedBody === "object") {
      return {
        ok: true,
        data: parsedBody as Record<string, unknown>
      };
    }

    return {
      ok: true,
      data: { value: parsedBody }
    };
  }

  private parseBody(body: string): unknown {
    if (!body || body.trim().length === 0) {
      return {};
    }

    try {
      return JSON.parse(body) as unknown;
    } catch {
      return { raw: body };
    }
  }

  private extractErrorMessage(body: unknown, statusCode: number): string {
    if (body && typeof body === "object") {
      const typed = body as Record<string, unknown>;
      if (typeof typed.message === "string") {
        return `Appwrite ${statusCode}: ${typed.message}`;
      }
    }

    return `Appwrite request failed with status ${statusCode}`;
  }

  private buildRequest(operation: MutationOperation): HttpOperationRequest {
    switch (operation.action) {
      case "project.create":
        return {
          method: "POST",
          path: "projects",
          body: operation.params
        };

      case "project.delete": {
        const projectId = this.readString(operation.params, [
          "project_id",
          "delete_project_id"
        ]);
        return {
          method: "DELETE",
          path: `projects/${encodeURIComponent(projectId)}`
        };
      }

      case "database.create":
        return {
          method: "POST",
          path: "databases",
          body: operation.params
        };

      case "database.upsert_collection": {
        const databaseId = this.readString(operation.params, ["database_id"]);
        const collectionId = this.readOptionalString(operation.params, [
          "collection_id"
        ]);

        if (collectionId) {
          return {
            method: "PUT",
            path: `databases/${encodeURIComponent(databaseId)}/collections/${encodeURIComponent(collectionId)}`,
            body: operation.params
          };
        }

        return {
          method: "POST",
          path: `databases/${encodeURIComponent(databaseId)}/collections`,
          body: operation.params
        };
      }

      case "database.delete_collection": {
        const databaseId = this.readString(operation.params, ["database_id"]);
        const collectionId = this.readString(operation.params, ["collection_id"]);

        return {
          method: "DELETE",
          path: `databases/${encodeURIComponent(databaseId)}/collections/${encodeURIComponent(collectionId)}`
        };
      }

      case "auth.users.list": {
        return {
          method: "GET",
          path: "users",
          query: this.asQuery(operation.params)
        };
      }

      case "auth.users.create":
        return {
          method: "POST",
          path: "users",
          body: operation.params
        };

      case "auth.users.update": {
        const userId = this.readString(operation.params, ["user_id"]);

        return {
          method: "PATCH",
          path: `users/${encodeURIComponent(userId)}`,
          body: operation.params
        };
      }

      case "function.create":
        return {
          method: "POST",
          path: "functions",
          body: operation.params
        };

      case "function.update": {
        const functionId = this.readString(operation.params, ["function_id"]);

        return {
          method: "PUT",
          path: `functions/${encodeURIComponent(functionId)}`,
          body: operation.params
        };
      }

      case "function.deployment.trigger": {
        const functionId = this.readString(operation.params, ["function_id"]);

        return {
          method: "POST",
          path: `functions/${encodeURIComponent(functionId)}/deployments`,
          body: operation.params
        };
      }

      case "function.execution.trigger": {
        const functionId = this.readString(operation.params, ["function_id"]);

        return {
          method: "POST",
          path: `functions/${encodeURIComponent(functionId)}/executions`,
          body: operation.params
        };
      }

      case "function.execution.status": {
        const functionId = this.readString(operation.params, ["function_id"]);
        const executionId = this.readString(operation.params, ["execution_id"]);

        return {
          method: "GET",
          path: `functions/${encodeURIComponent(functionId)}/executions/${encodeURIComponent(executionId)}`
        };
      }

      default:
        return this.exhaustiveAction(operation.action);
    }
  }

  private readString(
    params: Record<string, unknown>,
    keys: string[]
  ): string {
    for (const key of keys) {
      const value = params[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }

    throw new AppwriteMcpError(
      "VALIDATION_ERROR",
      `missing required parameter: one of ${keys.join(", ")}`,
      {
        operation_id: "*",
        target: "params"
      }
    );
  }

  private readOptionalString(
    params: Record<string, unknown>,
    keys: string[]
  ): string | undefined {
    for (const key of keys) {
      const value = params[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }

    return undefined;
  }

  private asQuery(
    params: Record<string, unknown>
  ): Record<string, string | number | boolean> {
    const query: Record<string, string | number | boolean> = {};

    for (const [key, value] of Object.entries(params)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        query[key] = value;
      }
    }

    return query;
  }

  private exhaustiveAction(action: never): never {
    throw new AppwriteMcpError("VALIDATION_ERROR", `unsupported action: ${action}`, {
      target: "operation",
      operation_id: "*"
    });
  }
}
