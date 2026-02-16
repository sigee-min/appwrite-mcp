# appwrite-mcp

MCP server for controlled Appwrite mutations with preview/apply workflow, plan hashing, per-target auth contexts, and safety checks for destructive operations.

## What is implemented

- JSON-RPC tool surface:
  - `capabilities.list`
  - `context.get`
  - `targets.resolve`
  - `scopes.catalog.get`
  - `changes.preview`
  - `changes.apply`
  - `confirm.issue`
- Runtime transports:
  - `stdio` (default)
  - `streamable-http` (opt-in)
- Core safety model:
  - plan id/hash validation between preview and apply
  - confirmation token for critical destructive operations
  - per-project auth context + scope checks
  - secret redaction in logs/results

## Requirements

- Node.js 20+
- npm

## Install

```bash
npm install
```

## Auth file

Set `APPWRITE_PROJECT_AUTH_FILE` to a JSON file in this shape:

```json
{
  "default_endpoint": "https://cloud.appwrite.io/v1",
  "projects": {
    "PROJECT_A": {
      "api_key": "sk_a"
    },
    "PROJECT_B": {
      "api_key": "sk_b"
    }
  }
}
```

Optional UX fields for auto-targeting:

```json
{
  "default_endpoint": "https://cloud.appwrite.io/v1",
  "projects": {
    "PROJECT_A": {
      "api_key": "sk_a",
      "aliases": ["prod", "main"],
      "default_for_auto": true
    }
  },
  "defaults": {
    "auto_target_project_ids": ["PROJECT_A"],
    "target_selector": { "mode": "auto" }
  }
}
```

Optional management channel for project operations:

```json
{
  "default_endpoint": "https://cloud.appwrite.io/v1",
  "projects": {
    "PROJECT_A": {
      "api_key": "sk_a"
    }
  },
  "management": {
    "endpoint": "https://cloud.appwrite.io/v1",
    "api_key": "sk_mgmt",
    "project_id": "console"
  }
}
```

When `targets` are omitted, the server can resolve targets from `target_selector` (or from `defaults` in auth file).
Scope entries are optional metadata and are not required in user-facing setup.

## Run (stdio)

```bash
APPWRITE_PROJECT_AUTH_FILE=/path/to/project-auth.json npm run dev
```

`stdio` is the default transport.

## Run (streamable-http)

Enable and select `streamable-http`:

```bash
APPWRITE_PROJECT_AUTH_FILE=/path/to/project-auth.json \
APPWRITE_MCP_ENABLE_STREAMABLE_HTTP=true \
APPWRITE_MCP_TRANSPORT=streamable-http \
npm run dev
```

Optional streamable-http bind settings:

- `APPWRITE_MCP_HTTP_HOST` (default: `127.0.0.1`)
- `APPWRITE_MCP_HTTP_PORT` (default: `8080`)
- `APPWRITE_MCP_HTTP_PATH` (default: `/mcp`)
- `APPWRITE_MCP_ALLOW_REMOTE_HTTP` (required when host is not loopback)

When streamable-http starts, the server logs its listening URL to stderr.

## Other environment variables

- `APPWRITE_MCP_CONFIRM_SECRET` (default: `appwrite-mcp-dev-secret`)
- `APPWRITE_MCP_TARGET_ALIASES` (JSON map of alias -> project_id)
- `APPWRITE_MCP_ENABLE_PROJECT_MANAGEMENT` (`true/false`)
- `APPWRITE_MCP_DISALLOW_LEGACY_AUTH_USERS_UPDATE` (`true/false`)
- `APPWRITE_MCP_HTTP_TIMEOUT_MS` (default: `10000`)
- `APPWRITE_MCP_HTTP_MAX_RETRIES` (default: `2`, retry only for GET or idempotent operations)
- `APPWRITE_MCP_HTTP_RETRY_BASE_DELAY_MS` (default: `100`)
- `APPWRITE_MCP_HTTP_RETRY_MAX_DELAY_MS` (default: `2000`)
- `APPWRITE_MCP_HTTP_RETRY_STATUS_CODES` (default: `408,425,429,500,502,503,504`)

Production note:

- With `NODE_ENV=production`, you must set `APPWRITE_MCP_CONFIRM_SECRET` to a non-default value.

Deprecation note:

- `auth.users.update` is a compatibility alias. Prefer explicit actions:
  - `auth.users.update.email`
  - `auth.users.update.name`
  - `auth.users.update.status`
  - `auth.users.update.password`
  - `auth.users.update.phone`
  - `auth.users.update.email_verification`
  - `auth.users.update.phone_verification`
  - `auth.users.update.mfa`
  - `auth.users.update.labels`
  - `auth.users.update.prefs`
- Set `APPWRITE_MCP_DISALLOW_LEGACY_AUTH_USERS_UPDATE=true` to enforce explicit actions only.

## Development commands

```bash
npm test
npm run build
npm run start
npm run test:openapi:online
npm run test:e2e:live
npm run test:e2e:live:extended
```

- `test:openapi:online`: optional online contract guard against official Appwrite OpenAPI.
- `test:e2e:live`: optional live end-to-end test (requires real credentials and target project).
- `test:e2e:live:extended`: optional live read-only test for auth/database/function list actions.

## Docker deploy

Deploy files are under `deploy/`:

- `deploy/Dockerfile`
- `deploy/docker-compose.yml`
- `deploy/.env.example`
- `deploy/config/project-auth.example.json`

Quick start:

```bash
cd deploy
cp .env.example .env
cp config/project-auth.example.json config/project-auth.json
docker compose up -d --build
```

## Manual smoke

Manual smoke runbook: `docs/scn-020-manual-smoke.md`

Run:

```bash
APPWRITE_PROJECT_AUTH_FILE=/path/to/project-auth.json \
APPWRITE_SMOKE_TARGETS=PROJECT_A,PROJECT_B \
npm run smoke:e2e:manual
```

## Project structure

- `src/core/` - preview/apply orchestration and planning
- `src/adapters/` - Appwrite HTTP adapter
- `src/mcp/` - JSON-RPC transport servers
- `src/config/` - runtime config and service builder
- `src/e2e/` - manual smoke runner
- `test/` - unit/contract/fixture tests

## Additional references

- API mapping: `docs/api-endpoint-mapping.md`
- Ops runbook: `docs/ops-runbook.md`
- Release runbook: `docs/releases.md`

## License

MIT. See `LICENSE`.
