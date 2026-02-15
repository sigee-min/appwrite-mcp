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
      "api_key": "sk_a",
      "scopes": ["users.read", "users.write"]
    },
    "PROJECT_B": {
      "api_key": "sk_b",
      "scopes": ["users.read"]
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
      "scopes": ["users.read", "users.write"],
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

When `targets` are omitted, the server can resolve targets from `target_selector` (or from `defaults` in auth file).

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

Production note:

- With `NODE_ENV=production`, you must set `APPWRITE_MCP_CONFIRM_SECRET` to a non-default value.

## Development commands

```bash
npm test
npm run build
npm run start
```

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
