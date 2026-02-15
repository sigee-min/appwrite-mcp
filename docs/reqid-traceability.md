# ReqID Traceability

| ReqID | Test Coverage |
| --- | --- |
| APWMCP-REQ-001 | `ORC-FX-001` |
| APWMCP-REQ-002 | `ORC-FX-002` |
| APWMCP-REQ-003 | `ORC-FX-002` |
| APWMCP-REQ-004 | `ORC-FX-004` |
| APWMCP-REQ-005 | `ORC-FX-002` |
| APWMCP-REQ-006 | `ORC-FX-002`, `ORC-FX-003` |
| APWMCP-REQ-007 | `extra: unresolved alias returns TARGET_NOT_FOUND` |
| APWMCP-REQ-008 | `ORC-FX-003` |
| APWMCP-REQ-009 | `ORC-FX-003` |
| APWMCP-REQ-010 | `ORC-FX-003` |
| APWMCP-REQ-011 | `ORC-FX-003` |
| APWMCP-REQ-012 | `ORC-FX-005`, `HttpAppwriteAdapter contract` |
| APWMCP-REQ-013 | `ORC-FX-006` |
| APWMCP-REQ-014 | `ORC-FX-009`, `HttpAppwriteAdapter contract` |
| APWMCP-REQ-015 | `ORC-FX-009`, `HttpAppwriteAdapter contract` |
| APWMCP-REQ-016 | `ORC-FX-009`, `HttpAppwriteAdapter contract` |
| APWMCP-REQ-017 | `ORC-FX-007`, `ORC-FX-008` |
| APWMCP-REQ-018 | `ORC-FX-007` |
| APWMCP-REQ-019 | `ORC-FX-008` |
| APWMCP-REQ-020 | `ORC-FX-008` |
| APWMCP-REQ-021 | `ORC-FX-008`, `extra: expired confirmation token is rejected` |
| APWMCP-REQ-022 | `ORC-FX-010` |
| APWMCP-REQ-023 | `ORC-FX-010`, `HttpAppwriteAdapter contract` |
| APWMCP-REQ-024 | `ORC-FX-011` |
| APWMCP-REQ-025 | `ORC-FX-011` |
| APWMCP-REQ-026 | `ORC-FX-011` |
| APWMCP-REQ-027 | `ORC-FX-011` |
| APWMCP-REQ-028 | `ORC-FX-011`, `extra: unknown tool failure includes correlation_id` |
| APWMCP-REQ-029 | `ORC-FX-012` |
| APWMCP-REQ-030 | `ORC-FX-012` |
| APWMCP-REQ-031 | `ORC-FX-013` |
| APWMCP-REQ-032 | `ORC-FX-001`, `ORC-FX-013` |
| APWMCP-REQ-033 | `ORC-FX-013` |
| APWMCP-REQ-034 | `ORC-FX-014` |
| APWMCP-REQ-035 | `ORC-FX-015`, `ORC-FX-016` |
| APWMCP-REQ-036 | `ORC-FX-015`, `ORC-FX-016` |
| APWMCP-REQ-037 | `ORC-FX-016` |
| APWMCP-REQ-038 | `ORC-FX-015` |
| APWMCP-REQ-039 | `ORC-FX-017` |
| APWMCP-REQ-040 | `ORC-FX-018` |
| APWMCP-REQ-041 | `ORC-FX-019` |

## SCN-020 Smoke ReqID Traceability

| ReqID | Evidence |
| --- | --- |
| SMK-001 | `parseManualSmokeConfig` target/env validation |
| SMK-002 | `runManualSmokeSuite` executes `preview -> apply` for each case |
| SMK-003 | `APPWRITE_PROJECT_AUTH_FILE` only input path in manual runner |
| SMK-010 | `CASE-01`, `CASE-02`, `CASE-03` execution in manual suite |
| SMK-011 | `runManualSmokeSuite` captures correlation/status contract from core service |
| SMK-012 | `CASE-02` expected status `PARTIAL_SUCCESS` |
| SMK-013 | `CASE-03` expected status `FAILED` with error code capture |
| SMK-020 | JSON report output in `runCli` |
| SMK-021 | `target_results` includes `project_id`, `status`, `error_code` |
| SMK-022 | per-case `retry_guidance` emitted in report |
| SMK-030 | manual-only gate `--manual` enforcement |
| SMK-031 | deterministic case order (`CASE-01 -> CASE-02 -> CASE-03`) |
