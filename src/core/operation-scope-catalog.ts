import type { MutationOperation, OperationAction } from "../domain/types.js";

export const SCOPE_CATALOG_VERSION = "2026-02-16.1";

const actionRequiredScopes: Record<OperationAction, string[]> = {
  "project.create": ["projects.write"],
  "project.delete": ["projects.write"],
  "database.create": ["databases.write"],
  "database.upsert_collection": ["databases.write"],
  "database.delete_collection": ["databases.write"],
  "auth.users.list": ["users.read"],
  "auth.users.create": ["users.write"],
  "auth.users.update": ["users.write"],
  "function.create": ["functions.write"],
  "function.update": ["functions.write"],
  "function.deployment.trigger": ["functions.write"],
  "function.execution.trigger": ["functions.write"],
  "function.execution.status": ["functions.write"]
};

export const scopeCatalog = {
  version: SCOPE_CATALOG_VERSION,
  actions: actionRequiredScopes
};

export const withInferredRequiredScopes = (
  operations: MutationOperation[]
): MutationOperation[] =>
  operations.map((operation) => {
    const inferred = actionRequiredScopes[operation.action] ?? [];
    const provided = operation.required_scopes ?? [];

    return {
      ...operation,
      required_scopes: [...new Set([...inferred, ...provided])]
    };
  });
