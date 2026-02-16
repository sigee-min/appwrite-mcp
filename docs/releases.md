# Release Runbook

This runbook standardizes staging, canary, and production promotion.

## Prerequisites

1. Clean working tree on release branch.
2. CI green on latest commit (`npm test`, `npm run build`).
3. Production secrets prepared:
   - `APPWRITE_PROJECT_AUTH_FILE_JSON`
   - `APPWRITE_LIVE_TARGET_PROJECT_ID`
   - `APPWRITE_MCP_CONFIRM_SECRET`

## Versioning Policy

- Follow semver (`major.minor.patch`).
- `major`: breaking API behavior or removal of compatibility aliases.
- `minor`: backward-compatible features and new actions.
- `patch`: bug fixes, docs updates, non-breaking hardening.

## Release Steps

1. Validate baseline locally
   - `npm test`
   - `npm run build`
   - `npm run test:openapi:online`
2. Optional live validation
   - `npm run test:e2e:live`
3. Trigger GitHub release workflow
   - Workflow: `release.yml`
   - Input: semantic version without `v` prefix (example: `0.2.0`)
   - Optional: enable online contract check and live e2e gates.
4. Confirm release artifacts
   - Tag `v<version>` created.
   - GitHub release entry published with generated notes.

## Rollback Steps

1. Disable new rollout flags if related:
   - `APPWRITE_MCP_DISALLOW_LEGACY_AUTH_USERS_UPDATE=false`
2. Re-deploy previous known-good image/tag.
3. Re-run smoke verification:
   - `npm run smoke:e2e:manual`
4. Record incident details in runbook / issue tracker.

## Post-Release Verification

1. Verify preview/apply/confirm flow for representative auth/database/function actions.
2. Verify project management operations with `management` auth context.
3. Monitor error trend:
   - `MISSING_SCOPE`
   - `AUTH_CONTEXT_REQUIRED`
   - `INTERNAL_ERROR`
4. Confirm no legacy action usage before enforcing strict legacy block policy.
