# Operations Runbook

## Preflight Checklist

1. Confirm `APPWRITE_PROJECT_AUTH_FILE` exists and is valid JSON.
2. Confirm each target project has valid `endpoint` and `api_key`.
3. For project management operations, confirm `management` auth context is configured.
4. Confirm `APPWRITE_MCP_CONFIRM_SECRET` is non-default in production.
5. Confirm transport config (`stdio` or `streamable-http`) is valid.

## Runtime Commands

- Unit/integration tests: `npm test`
- Build check: `npm run build`
- Manual smoke e2e: `npm run smoke:e2e:manual`
- Optional online OpenAPI guard: `npm run test:openapi:online`
- Optional live e2e: `npm run test:e2e:live`

## Failure Codes and Remediation

| Error Code | Meaning | Remediation |
| --- | --- | --- |
| `PLAN_MISMATCH` | Apply payload differs from preview plan | Re-run preview and use fresh `plan_id`/`plan_hash` |
| `TARGET_NOT_FOUND` | Alias/project target cannot be resolved | Fix targets or alias config in auth file |
| `TARGET_AMBIGUOUS` | Auto target selection not deterministic | Provide explicit targets/selector or defaults |
| `CAPABILITY_UNAVAILABLE` | Requested domain/channel disabled | Enable required channel (`project` management, transport) |
| `CONFIRM_REQUIRED` | Critical destructive operation missing/expired confirmation token | Issue token via `confirm.issue` and retry apply |
| `INVALID_CONFIRM_TOKEN` | Token invalid for plan hash | Issue a new token from latest preview hash |
| `MISSING_SCOPE` | API key permission metadata indicates missing permission | Use an API key with required permissions |
| `AUTH_CONTEXT_REQUIRED` | Missing endpoint/api_key for resolved target | Populate auth context in project auth file |
| `VALIDATION_ERROR` | Input schema or required parameters invalid | Correct request shape and required fields |
| `INTERNAL_ERROR` | Upstream or adapter internal failure | Retry if retryable; inspect logs and Appwrite status |

## Project Management Channel

- Project actions (`project.create`, `project.delete`) should use dedicated `management` auth context.
- Recommended permission for management key: project write capability.
- Do not reuse tenant/project keys for management operations.

## Deployment Operation Guidance

- `function.deployment.trigger` uses multipart upload.
- Required field: `code`.
- Optional fields: `activate`, `entrypoint`, `commands`.
- Validate deployment payload in preview before apply.

## Legacy Action Deprecation

- `auth.users.update` is deprecated in favor of explicit `auth.users.update.*` actions.
- During migration, compatibility alias is still supported and preview/apply summary annotates deprecated usage.
- Set `APPWRITE_MCP_DISALLOW_LEGACY_AUTH_USERS_UPDATE=true` to enforce explicit actions and fail fast.

## Rollout Checklist (staging -> canary -> production)

1. Staging preflight
   - Run `npm test` and `npm run build`.
   - Run `npm run test:openapi:online`.
   - Run `npm run test:e2e:live` against staging credentials.
2. Canary rollout
   - Deploy to canary environment with `APPWRITE_MCP_DISALLOW_LEGACY_AUTH_USERS_UPDATE=false`.
   - Monitor error mix (`MISSING_SCOPE`, `AUTH_CONTEXT_REQUIRED`, `INTERNAL_ERROR`) for 24h.
   - Confirm no unexpected `TARGET_AMBIGUOUS` spikes.
3. Production rollout
   - Promote same artifact used in canary.
   - Enforce non-default `APPWRITE_MCP_CONFIRM_SECRET`.
   - Optionally enable `APPWRITE_MCP_DISALLOW_LEGACY_AUTH_USERS_UPDATE=true` after all clients migrated.
4. Post-rollout validation
   - Verify preview/apply/confirm path for representative operations.
   - Validate project-management operations with dedicated management auth context.
