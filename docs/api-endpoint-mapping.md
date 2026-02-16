# API Endpoint Mapping

This document maps MCP operation actions to Appwrite REST endpoints.

## Project Domain

| Action | Method | Path | API Surface |
| --- | --- | --- | --- |
| `project.create` | `POST` | `/projects` | Console API |
| `project.delete` | `DELETE` | `/projects/{projectId}` | Console API |

## Database Domain

| Action | Method | Path | API Surface |
| --- | --- | --- | --- |
| `database.list` | `GET` | `/databases` | Server/Console |
| `database.create` | `POST` | `/databases` | Server/Console |
| `database.upsert_collection` | `POST` | `/databases/{databaseId}/collections` | Server/Console |
| `database.upsert_collection` | `PUT` | `/databases/{databaseId}/collections/{collectionId}` | Server/Console |
| `database.delete_collection` | `DELETE` | `/databases/{databaseId}/collections/{collectionId}` | Server/Console |

## Auth Domain

| Action | Method | Path | API Surface |
| --- | --- | --- | --- |
| `auth.users.list` | `GET` | `/users` | Server/Console |
| `auth.users.create` | `POST` | `/users` | Server/Console |
| `auth.users.update.email` | `PATCH` | `/users/{userId}/email` | Server/Console |
| `auth.users.update.name` | `PATCH` | `/users/{userId}/name` | Server/Console |
| `auth.users.update.status` | `PATCH` | `/users/{userId}/status` | Server/Console |
| `auth.users.update.password` | `PATCH` | `/users/{userId}/password` | Server/Console |
| `auth.users.update.phone` | `PATCH` | `/users/{userId}/phone` | Server/Console |
| `auth.users.update.email_verification` | `PATCH` | `/users/{userId}/verification` | Server/Console |
| `auth.users.update.phone_verification` | `PATCH` | `/users/{userId}/verification/phone` | Server/Console |
| `auth.users.update.mfa` | `PATCH` | `/users/{userId}/mfa` | Server/Console |
| `auth.users.update.labels` | `PUT` | `/users/{userId}/labels` | Server/Console |
| `auth.users.update.prefs` | `PATCH` | `/users/{userId}/prefs` | Server/Console |
| `auth.users.update` | dynamic | resolves to one of the explicit update endpoints | Compatibility alias |

Deprecation policy:

- `auth.users.update` is a legacy compatibility alias and should be migrated to explicit `auth.users.update.*` actions.
- Runtime enforcement is available with `APPWRITE_MCP_DISALLOW_LEGACY_AUTH_USERS_UPDATE=true`.

## Function Domain

| Action | Method | Path | API Surface |
| --- | --- | --- | --- |
| `function.list` | `GET` | `/functions` | Server/Console |
| `function.create` | `POST` | `/functions` | Server/Console |
| `function.update` | `PUT` | `/functions/{functionId}` | Server/Console |
| `function.deployment.trigger` | `POST` | `/functions/{functionId}/deployments` | Server/Console (multipart/form-data) |
| `function.execution.trigger` | `POST` | `/functions/{functionId}/executions` | Server/Console |
| `function.execution.status` | `GET` | `/functions/{functionId}/executions/{executionId}` | Server/Console |

## Contract Guard

- Optional online contract test: `npm run test:openapi:online`
- Test file: `test/openapi-contract-guard.test.ts`
