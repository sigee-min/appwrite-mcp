# appwrite-mcp

[![CI](https://github.com/sigee-min/appwrite-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sigee-min/appwrite-mcp/actions/workflows/ci.yml)
[![Release](https://github.com/sigee-min/appwrite-mcp/actions/workflows/release.yml/badge.svg)](https://github.com/sigee-min/appwrite-mcp/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

MCP server for controlled Appwrite mutations with preview/apply workflow, plan hashing, per-target auth contexts, and safety checks for destructive operations.

## Quick Start (OpenCode + stdio)

For personal local use, copy these two blocks.

1) Save as `/absolute/path/project-auth.json`:

```json
{
  "default_endpoint": "https://your-appwrite-domain/v1",
  "projects": {
    "YOUR_PROJECT_ID": {
      "api_key": "sk_your_api_key"
    }
  }
}
```

2) Add this under `mcp` in `~/.config/opencode/opencode.json`:

```json
{
  "appwrite_local": {
    "type": "local",
    "enabled": true,
    "environment": {
      "APPWRITE_PROJECT_AUTH_FILE": "/absolute/path/project-auth.json",
      "APPWRITE_MCP_CONFIRM_SECRET": "change-me-before-production"
    },
    "command": [
      "npx",
      "-y",
      "--package",
      "https://github.com/sigee-min/appwrite-mcp/releases/latest/download/appwrite-mcp-npx.tgz",
      "appwrite-mcp"
    ]
  }
}
```

Verify with `opencode mcp list`.

For version pinning and release assets, see `docs/releases.md`.

### One-off run (optional)

```bash
APPWRITE_PROJECT_AUTH_FILE=/absolute/path/project-auth.json \
APPWRITE_MCP_CONFIRM_SECRET=change-me-before-production \
npx -y --package https://github.com/sigee-min/appwrite-mcp/releases/latest/download/appwrite-mcp-npx.tgz appwrite-mcp
```

## Local Source Run

```bash
npm install
APPWRITE_PROJECT_AUTH_FILE=/path/to/project-auth.json npm run dev
```

`stdio` is the default transport.

## Core Capabilities

- JSON-RPC tools: `capabilities.list`, `context.get`, `targets.resolve`, `scopes.catalog.get`, `changes.preview`, `changes.apply`, `confirm.issue`
- Transports: `stdio` (default), `streamable-http` (opt-in)
- Safety controls: plan hash validation, confirmation tokens for critical destructive operations, auth-context resolution, secret redaction

## Supported Actions (Current)

- Read-only: `auth.users.list`, `database.list`, `function.list`, `function.execution.status`
- Mutations: `project.create|delete`, `database.create|upsert_collection|delete_collection`, `auth.users.create|update.*`, `function.create|update|deployment.trigger|execution.trigger`
- Compatibility alias: `auth.users.update` (deprecated, still supported unless blocked)

## Safety Defaults

- `changes.apply` requires matching `plan_id` and `plan_hash` from preview.
- Critical destructive operations require `confirm.issue` token.
- `project.*` actions require management capability and management auth context.
- Scope metadata in auth file is optional for user-facing setup.
- In production, set `APPWRITE_MCP_CONFIRM_SECRET` to a non-default value.

## Auth File Notes

Required shape:

```json
{
  "default_endpoint": "https://cloud.appwrite.io/v1",
  "projects": {
    "PROJECT_A": {
      "api_key": "sk_a"
    }
  }
}
```

Optional fields:

- `projects.<id>.aliases` and `projects.<id>.default_for_auto`
- `defaults.auto_target_project_ids` and `defaults.target_selector`
- `management` auth context for `project.*` operations

Example files: `deploy/config/project-auth.example.json`

## Optional Transport: streamable-http

```bash
APPWRITE_PROJECT_AUTH_FILE=/path/to/project-auth.json \
APPWRITE_MCP_ENABLE_STREAMABLE_HTTP=true \
APPWRITE_MCP_TRANSPORT=streamable-http \
npm run dev
```

Additional bind settings:

- `APPWRITE_MCP_HTTP_HOST` (default: `127.0.0.1`)
- `APPWRITE_MCP_HTTP_PORT` (default: `8080`)
- `APPWRITE_MCP_HTTP_PATH` (default: `/mcp`)
- `APPWRITE_MCP_ALLOW_REMOTE_HTTP=true` (required for non-loopback bind)

## Development and Validation

```bash
npm test
npm run build
npm run test:openapi:online
npm run test:e2e:live
npm run test:e2e:live:extended
npm run smoke:e2e:manual
```

## Docker (Optional)

```bash
cd deploy
cp .env.example .env
cp config/project-auth.example.json config/project-auth.json
docker compose up -d --build
```

## Docs

- API endpoint mapping: `docs/api-endpoint-mapping.md`
- Operations runbook: `docs/ops-runbook.md`
- Release runbook: `docs/releases.md`
- Manual smoke scenario: `docs/scn-020-manual-smoke.md`

## License

MIT. See `LICENSE`.
