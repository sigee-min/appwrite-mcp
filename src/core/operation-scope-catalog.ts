import type { MutationOperation, OperationAction } from "../domain/types.js";

export const SCOPE_CATALOG_VERSION = "2026-02-16.3";

const actionRequiredScopes: Record<OperationAction, string[]> = {
  "project.create": ["projects.write"],
  "project.delete": ["projects.write"],
  "database.list": ["databases.read"],
  "database.create": ["databases.write"],
  "database.upsert_collection": ["databases.write"],
  "database.delete_collection": ["databases.write"],
  "auth.users.list": ["users.read"],
  "auth.users.create": ["users.write"],
  "auth.users.update.email": ["users.write"],
  "auth.users.update.name": ["users.write"],
  "auth.users.update.status": ["users.write"],
  "auth.users.update.password": ["users.write"],
  "auth.users.update.phone": ["users.write"],
  "auth.users.update.email_verification": ["users.write"],
  "auth.users.update.phone_verification": ["users.write"],
  "auth.users.update.mfa": ["users.write"],
  "auth.users.update.labels": ["users.write"],
  "auth.users.update.prefs": ["users.write"],
  "auth.users.update": ["users.write"],
  "function.list": ["functions.read"],
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
