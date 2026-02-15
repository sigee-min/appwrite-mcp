import type {
  AuthContext,
  MutationOperation,
  StandardError
} from "../domain/types.js";

export interface AppwriteAdapterExecutionInput {
  target_project_id: string;
  operation: MutationOperation;
  auth_context: AuthContext;
  correlation_id: string;
}

interface AdapterExecutionSuccess {
  ok: true;
  data: Record<string, unknown>;
}

interface AdapterExecutionFailure {
  ok: false;
  error: StandardError;
}

export type AdapterExecutionResult =
  | AdapterExecutionSuccess
  | AdapterExecutionFailure;

export interface AppwriteAdapter {
  executeOperation(
    input: AppwriteAdapterExecutionInput
  ): Promise<AdapterExecutionResult>;
}
