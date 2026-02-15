import type {
  ErrorCode,
  MutationErrorResponse,
  MutationMode,
  StandardError,
  TransportName
} from "./types.js";
import { redactSecrets } from "./redaction.js";

interface ErrorOptions {
  target?: string;
  operation_id?: string;
  retryable?: boolean;
  missing_scopes?: string[];
  supported_transports?: TransportName[];
  remediation?: string;
}

export class AppwriteMcpError extends Error {
  readonly code: ErrorCode;
  readonly target: string;
  readonly operationId: string;
  readonly retryable: boolean;
  readonly missingScopes?: string[];
  readonly supportedTransports?: TransportName[];
  readonly remediation?: string;

  constructor(code: ErrorCode, message: string, options: ErrorOptions = {}) {
    super(message);
    this.name = "AppwriteMcpError";
    this.code = code;
    this.target = options.target ?? "global";
    this.operationId = options.operation_id ?? "*";
    this.retryable = options.retryable ?? false;
    this.missingScopes = options.missing_scopes;
    this.supportedTransports = options.supported_transports;
    this.remediation = options.remediation;
  }
}

export const toStandardError = (error: AppwriteMcpError): StandardError =>
  redactSecrets({
    code: error.code,
    message: error.message,
    target: error.target,
    operation_id: error.operationId,
    retryable: error.retryable,
    missing_scopes: error.missingScopes,
    supported_transports: error.supportedTransports,
    remediation: error.remediation
  }) as StandardError;

export const toMutationErrorResponse = (
  mode: MutationMode,
  correlationId: string,
  error: AppwriteMcpError
): MutationErrorResponse => ({
  correlation_id: correlationId,
  mode,
  status: "FAILED",
  summary: `${error.target} failed: ${error.code}`,
  error: toStandardError(error)
});
