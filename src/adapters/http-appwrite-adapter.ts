import { AppwriteMcpError, toStandardError } from "../domain/errors.js";
import type { MutationOperation } from "../domain/types.js";
import type {
  AdapterExecutionResult,
  AppwriteAdapter,
  AppwriteAdapterExecutionInput
} from "../core/appwrite-adapter.js";

interface HttpOperationRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  formData?: FormData;
  query?: Record<string, string | number | boolean>;
  omitProjectHeader?: boolean;
}

export interface HttpAppwriteAdapterOptions {
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryStatusCodes?: number[];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;
const DEFAULT_RETRY_MAX_DELAY_MS = 2_000;
const DEFAULT_RETRY_STATUS_CODES = [408, 425, 429, 500, 502, 503, 504];

export class HttpAppwriteAdapter implements AppwriteAdapter {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retryStatusCodes: Set<number>;

  constructor(options: HttpAppwriteAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.retryStatusCodes = new Set(
      options.retryStatusCodes ?? DEFAULT_RETRY_STATUS_CODES
    );
  }

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
      "X-Appwrite-Key": input.auth_context.api_key ?? "",
      "X-Appwrite-Response-Format": "1.8.0"
    };

    if (!request.omitProjectHeader) {
      headers["X-Appwrite-Project"] = input.target_project_id;
    }

    if (!request.formData) {
      headers["Content-Type"] = "application/json";
    }

    const canRetry = this.canRetryRequest(request, input.operation);
    const maxAttempts = canRetry ? this.maxRetries + 1 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(url, {
          method: request.method,
          headers,
          body: request.formData
            ? request.formData
            : request.body
              ? JSON.stringify(request.body)
              : undefined
        });

        const textBody = await response.text();
        const parsedBody = this.parseBody(textBody);
        const retryableStatus = this.retryStatusCodes.has(response.status);

        if (!response.ok) {
          if (retryableStatus && attempt < maxAttempts) {
            await this.sleep(this.retryDelayMs(attempt));
            continue;
          }

          const message = this.extractErrorMessage(parsedBody, response.status);
          return {
            ok: false,
            error: {
              code: "INTERNAL_ERROR",
              message,
              target: input.target_project_id,
              operation_id: input.operation.operation_id,
              retryable: retryableStatus
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
      } catch (error) {
        const retryableError = this.isRetryableError(error);
        if (retryableError && attempt < maxAttempts) {
          await this.sleep(this.retryDelayMs(attempt));
          continue;
        }

        return {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: this.extractRuntimeMessage(error),
            target: input.target_project_id,
            operation_id: input.operation.operation_id,
            retryable: retryableError
          }
        };
      }
    }

    return {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "request retries exhausted",
        target: input.target_project_id,
        operation_id: input.operation.operation_id,
        retryable: true
      }
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

  private async fetchWithTimeout(
    url: URL,
    init: {
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      headers: Record<string, string>;
      body?: FormData | string;
    }
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private canRetryRequest(
    request: HttpOperationRequest,
    operation: MutationOperation
  ): boolean {
    return request.method === "GET" || typeof operation.idempotency_key === "string";
  }

  private retryDelayMs(attempt: number): number {
    const base = Math.min(
      this.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1),
      this.retryMaxDelayMs
    );
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base * 0.25)));
    return base + jitter;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof AppwriteMcpError) {
      return false;
    }

    if (error instanceof Error && error.name === "AbortError") {
      return true;
    }

    return true;
  }

  private extractRuntimeMessage(error: unknown): string {
    if (error instanceof Error && error.name === "AbortError") {
      return `Appwrite request timed out after ${this.timeoutMs}ms`;
    }

    if (error instanceof Error && error.message.length > 0) {
      return `Appwrite request failed: ${error.message}`;
    }

    return "Appwrite request failed due to unexpected runtime error";
  }

  private buildRequest(operation: MutationOperation): HttpOperationRequest {
    switch (operation.action) {
      case "project.create":
        return {
          method: "POST",
          path: "projects",
          body: this.toProjectCreateBody(operation.params),
          omitProjectHeader: true
        };

      case "project.delete": {
        const projectId = this.readString(operation.params, [
          "projectId",
          "project_id",
          "delete_project_id"
        ]);
        return {
          method: "DELETE",
          path: `projects/${encodeURIComponent(projectId)}`,
          omitProjectHeader: true
        };
      }

      case "database.list": {
        return {
          method: "GET",
          path: "databases",
          query: this.asQuery(operation.params)
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

      case "auth.users.update.email":
        return this.buildAuthUsersUpdateRequest(operation, "email");

      case "auth.users.update.name":
        return this.buildAuthUsersUpdateRequest(operation, "name");

      case "auth.users.update.status":
        return this.buildAuthUsersUpdateRequest(operation, "status");

      case "auth.users.update.password":
        return this.buildAuthUsersUpdateRequest(operation, "password");

      case "auth.users.update.phone":
        return this.buildAuthUsersUpdateRequest(operation, "phone");

      case "auth.users.update.email_verification":
        return this.buildAuthUsersUpdateRequest(operation, "emailVerification");

      case "auth.users.update.phone_verification":
        return this.buildAuthUsersUpdateRequest(operation, "phoneVerification");

      case "auth.users.update.mfa":
        return this.buildAuthUsersUpdateRequest(operation, "mfa");

      case "auth.users.update.labels":
        return this.buildAuthUsersUpdateRequest(operation, "labels");

      case "auth.users.update.prefs":
        return this.buildAuthUsersUpdateRequest(operation, "prefs");

      case "auth.users.update": {
        return this.buildAuthUsersUpdateRequest(operation, "auto");
      }

      case "function.list":
        return {
          method: "GET",
          path: "functions",
          query: this.asQuery(operation.params)
        };

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
          formData: this.toFunctionDeploymentFormData(operation)
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

  private buildAuthUsersUpdateRequest(
    operation: MutationOperation,
    expectedField:
      | "auto"
      | "email"
      | "name"
      | "status"
      | "password"
      | "phone"
      | "emailVerification"
      | "phoneVerification"
      | "mfa"
      | "labels"
      | "prefs"
  ): HttpOperationRequest {
    const userId = this.readString(operation.params, ["user_id"]);

    const allow = (field: string): boolean =>
      expectedField === "auto" || expectedField === field;

    if (allow("email") && typeof operation.params.email === "string") {
      return {
        method: "PATCH",
        path: `users/${encodeURIComponent(userId)}/email`,
        body: { email: operation.params.email }
      };
    }

    if (allow("name") && typeof operation.params.name === "string") {
      return {
        method: "PATCH",
        path: `users/${encodeURIComponent(userId)}/name`,
        body: { name: operation.params.name }
      };
    }

    if (allow("status") && typeof operation.params.status === "boolean") {
      return {
        method: "PATCH",
        path: `users/${encodeURIComponent(userId)}/status`,
        body: { status: operation.params.status }
      };
    }

    if (allow("password") && typeof operation.params.password === "string") {
      return {
        method: "PATCH",
        path: `users/${encodeURIComponent(userId)}/password`,
        body: { password: operation.params.password }
      };
    }

    if (allow("phone") && typeof operation.params.phone === "string") {
      return {
        method: "PATCH",
        path: `users/${encodeURIComponent(userId)}/phone`,
        body: { number: operation.params.phone }
      };
    }

    if (
      allow("emailVerification") &&
      typeof operation.params.emailVerification === "boolean"
    ) {
      return {
        method: "PATCH",
        path: `users/${encodeURIComponent(userId)}/verification`,
        body: { emailVerification: operation.params.emailVerification }
      };
    }

    if (
      allow("phoneVerification") &&
      typeof operation.params.phoneVerification === "boolean"
    ) {
      return {
        method: "PATCH",
        path: `users/${encodeURIComponent(userId)}/verification/phone`,
        body: { phoneVerification: operation.params.phoneVerification }
      };
    }

    if (allow("mfa") && typeof operation.params.mfa === "boolean") {
      return {
        method: "PATCH",
        path: `users/${encodeURIComponent(userId)}/mfa`,
        body: { mfa: operation.params.mfa }
      };
    }

    if (allow("labels") && Array.isArray(operation.params.labels)) {
      return {
        method: "PUT",
        path: `users/${encodeURIComponent(userId)}/labels`,
        body: { labels: operation.params.labels }
      };
    }

    if (
      allow("prefs") &&
      operation.params.prefs &&
      typeof operation.params.prefs === "object" &&
      !Array.isArray(operation.params.prefs)
    ) {
      return {
        method: "PATCH",
        path: `users/${encodeURIComponent(userId)}/prefs`,
        body: { prefs: operation.params.prefs }
      };
    }

    throw new AppwriteMcpError(
      "VALIDATION_ERROR",
      "auth.users.update requires one supported field (email, name, status, password, phone, emailVerification, phoneVerification, mfa, labels, prefs)",
      {
        operation_id: operation.operation_id,
        target: "params"
      }
    );
  }

  private toProjectCreateBody(
    params: Record<string, unknown>
  ): Record<string, unknown> {
    const projectId = this.readString(params, ["projectId", "project_id"]);
    const teamId = this.readString(params, ["teamId", "team_id"]);
    const name = this.readString(params, ["name"]);

    return {
      ...params,
      projectId,
      teamId,
      name
    };
  }

  private toFunctionDeploymentFormData(operation: MutationOperation): FormData {
    const code = operation.params.code;
    if (typeof code !== "string") {
      throw new AppwriteMcpError(
        "VALIDATION_ERROR",
        "function.deployment.trigger requires code string",
        {
          operation_id: operation.operation_id,
          target: "params"
        }
      );
    }

    const formData = new FormData();
    formData.append("code", code);

    const activate =
      typeof operation.params.activate === "boolean"
        ? operation.params.activate
        : false;
    formData.append("activate", String(activate));

    if (typeof operation.params.entrypoint === "string") {
      formData.append("entrypoint", operation.params.entrypoint);
    }

    if (typeof operation.params.commands === "string") {
      formData.append("commands", operation.params.commands);
    }

    return formData;
  }
}
