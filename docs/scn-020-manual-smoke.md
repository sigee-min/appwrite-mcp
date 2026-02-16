# SCN-020 Manual Smoke Runbook

`SCN-020` smoke E2E is manual-only by policy. This runbook is cloud-first but keeps self-hosted portability by using only endpoint/auth-file switches.

## Preconditions

- `APPWRITE_PROJECT_AUTH_FILE` points to a JSON file with at least two projects.
- `APPWRITE_SMOKE_TARGETS` includes those two project ids.
- The auth file uses endpoint + key from environment/files only.

## Required Auth File Shape

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

Switching to self-hosted requires only changing endpoint values in this file.

## Run

```bash
APPWRITE_PROJECT_AUTH_FILE=/path/to/project-auth.json \
APPWRITE_SMOKE_TARGETS=PROJECT_A,PROJECT_B \
npm run smoke:e2e:manual
```

## Output Contract

- `stderr`: one-line human summary.
- `stdout`: JSON report with case results.

The report includes:

- `CASE-01`: expected `SUCCESS`
- `CASE-02`: expected `PARTIAL_SUCCESS`
- `CASE-03`: expected `FAILED`

If `CASE-02` does not produce `PARTIAL_SUCCESS`, use API keys with different permission sets so one target can execute the operation and the other cannot.
