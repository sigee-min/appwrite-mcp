import { readFileSync } from "node:fs";
import type {
  ApplyResponse,
  MutationErrorResponse,
  MutationOperation,
  MutationRequest,
  PreviewResponse,
  TargetOperationResult,
  TopLevelStatus
} from "../domain/types.js";
import { buildAppwriteControlService } from "../config/runtime-config.js";

type SmokeCaseId = "CASE-01" | "CASE-02" | "CASE-03";

interface SmokeCasePlan {
  id: SmokeCaseId;
  name: string;
  expectedStatus: TopLevelStatus;
  requiredScope: string;
  params: Record<string, unknown>;
}

interface SmokeTarget {
  projectId: string;
}

export interface ManualSmokeConfig {
  actor: string;
  targets: SmokeTarget[];
  endpoint: string;
  executionPolicy: "manual";
  cases: SmokeCasePlan[];
}

interface SmokeServiceLike {
  preview(input: unknown): PreviewResponse | MutationErrorResponse;
  apply(input: unknown): Promise<ApplyResponse | MutationErrorResponse>;
}

interface CliIo {
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
}

interface RunCliDependencies {
  serviceFactory?: (argv: string[], env: NodeJS.ProcessEnv) => SmokeServiceLike;
  io?: CliIo;
}

interface SmokeCaseResult {
  case_id: SmokeCaseId;
  case_name: string;
  expected_status: TopLevelStatus;
  observed_status: TopLevelStatus | "PREVIEW_FAILED";
  pass: boolean;
  correlation_id: string;
  retry_guidance: string;
  redaction_applied: boolean;
  target_results: Array<{
    project_id: string;
    status: "SUCCESS" | "FAILED";
    correlation_id: string;
    redaction_applied: boolean;
    error_code?: string;
  }>;
}

export interface ManualSmokeReport {
  generated_at: string;
  execution_policy: "manual";
  endpoint: string;
  actor: string;
  targets: string[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    overall: "PASS" | "FAIL";
  };
  cases: SmokeCaseResult[];
}

const readFirstProjectEndpoint = (authFilePath: string): string => {
  const raw = readFileSync(authFilePath, "utf8");
  const parsed = JSON.parse(raw) as {
    default_endpoint?: unknown;
    projects?: Record<string, { endpoint?: unknown }>;
  };

  if (typeof parsed.default_endpoint === "string" && parsed.default_endpoint.length > 0) {
    return parsed.default_endpoint;
  }

  if (parsed.projects && typeof parsed.projects === "object") {
    for (const value of Object.values(parsed.projects)) {
      if (typeof value.endpoint === "string" && value.endpoint.length > 0) {
        return value.endpoint;
      }
    }
  }

  return "unknown";
};

const parseTargets = (raw: string | undefined): SmokeTarget[] => {
  if (!raw) {
    throw new Error("APPWRITE_SMOKE_TARGETS is required");
  }

  const targets = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((projectId) => ({ projectId }));

  if (targets.length < 2) {
    throw new Error("APPWRITE_SMOKE_TARGETS must include at least two project ids");
  }

  return targets;
};

const defaultCases = (env: NodeJS.ProcessEnv): SmokeCasePlan[] => [
  {
    id: "CASE-01",
    name: "기본 성공",
    expectedStatus: "SUCCESS",
    requiredScope: env.APPWRITE_SMOKE_SUCCESS_SCOPE ?? "users.read",
    params: { limit: 1 }
  },
  {
    id: "CASE-02",
    name: "partial success",
    expectedStatus: "PARTIAL_SUCCESS",
    requiredScope: env.APPWRITE_SMOKE_PARTIAL_SCOPE ?? "users.write",
    params: { limit: 1 }
  },
  {
    id: "CASE-03",
    name: "권한 실패",
    expectedStatus: "FAILED",
    requiredScope: env.APPWRITE_SMOKE_AUTH_FAIL_SCOPE ?? "__missing_scope__",
    params: { limit: 1 }
  }
];

export const parseManualSmokeConfig = (env: NodeJS.ProcessEnv): ManualSmokeConfig => {
  const authFilePath = env.APPWRITE_PROJECT_AUTH_FILE;
  if (!authFilePath || authFilePath.trim().length === 0) {
    throw new Error("APPWRITE_PROJECT_AUTH_FILE is required for manual smoke");
  }

  return {
    actor: env.APPWRITE_SMOKE_ACTOR ?? "smoke-runner",
    targets: parseTargets(env.APPWRITE_SMOKE_TARGETS),
    endpoint: readFirstProjectEndpoint(authFilePath),
    executionPolicy: "manual",
    cases: defaultCases(env)
  };
};

const buildOperation = (casePlan: SmokeCasePlan): MutationOperation => ({
  operation_id: `${casePlan.id.toLowerCase()}-op-1`,
  domain: "auth",
  action: "auth.users.list",
  params: casePlan.params,
  required_scopes: [casePlan.requiredScope]
});

const buildPreviewRequest = (
  config: ManualSmokeConfig,
  casePlan: SmokeCasePlan
): MutationRequest => ({
  actor: config.actor,
  mode: "preview",
  targets: config.targets.map((target) => ({ project_id: target.projectId })),
  operations: [buildOperation(casePlan)],
  transport: "stdio"
});

const hasRedactionMarker = (value: unknown): boolean =>
  JSON.stringify(value).includes("***REDACTED***");

const targetResultToSummary = (
  result: TargetOperationResult
): { status: "SUCCESS" | "FAILED"; error_code?: string } =>
  result.status === "SUCCESS"
    ? { status: "SUCCESS" }
    : { status: "FAILED", error_code: result.error?.code };

const previewFailureCase = (
  casePlan: SmokeCasePlan,
  preview: MutationErrorResponse
): SmokeCaseResult => ({
  case_id: casePlan.id,
  case_name: casePlan.name,
  expected_status: casePlan.expectedStatus,
  observed_status: "PREVIEW_FAILED",
  pass: false,
  correlation_id: preview.correlation_id,
  retry_guidance: preview.error.remediation ?? "check preview input and retry",
  redaction_applied: hasRedactionMarker(preview),
  target_results: []
});

const buildCaseResult = (
  casePlan: SmokeCasePlan,
  applyResult: ApplyResponse | MutationErrorResponse
): SmokeCaseResult => {
  if (applyResult.status === "FAILED" && !("target_results" in applyResult)) {
    return {
      case_id: casePlan.id,
      case_name: casePlan.name,
      expected_status: casePlan.expectedStatus,
      observed_status: "FAILED",
      pass: casePlan.expectedStatus === "FAILED",
      correlation_id: applyResult.correlation_id,
      retry_guidance:
        applyResult.error.remediation ?? "check auth scopes and endpoint",
      redaction_applied: hasRedactionMarker(applyResult),
      target_results: []
    };
  }

  const targetResults = applyResult.target_results.map((target) => {
    const firstOperation = target.operations[0];
    const summary = firstOperation
      ? targetResultToSummary(firstOperation)
      : { status: target.status };
    return {
      project_id: target.project_id,
      status: summary.status,
      correlation_id: applyResult.correlation_id,
      redaction_applied: hasRedactionMarker(firstOperation ?? target),
      error_code: summary.error_code
    };
  });

  return {
    case_id: casePlan.id,
    case_name: casePlan.name,
    expected_status: casePlan.expectedStatus,
    observed_status: applyResult.status,
    pass: applyResult.status === casePlan.expectedStatus,
    correlation_id: applyResult.correlation_id,
    retry_guidance:
      applyResult.status === casePlan.expectedStatus
        ? "none"
        : "check project auth scopes and verify target-specific permissions",
    redaction_applied: hasRedactionMarker(applyResult),
    target_results: targetResults
  };
};

export const runManualSmokeSuite = async (
  service: SmokeServiceLike,
  config: ManualSmokeConfig
): Promise<ManualSmokeReport> => {
  const caseResults: SmokeCaseResult[] = [];

  for (const casePlan of config.cases) {
    const previewInput = buildPreviewRequest(config, casePlan);
    const preview = service.preview(previewInput);
    if (preview.status === "FAILED") {
      caseResults.push(previewFailureCase(casePlan, preview));
      continue;
    }

    const applyInput = {
      ...previewInput,
      mode: "apply" as const,
      plan_id: preview.plan_id,
      plan_hash: preview.plan_hash
    };
    const applyResult = await service.apply(applyInput);
    caseResults.push(buildCaseResult(casePlan, applyResult));
  }

  const passed = caseResults.filter((entry) => entry.pass).length;
  const failed = caseResults.length - passed;

  return {
    generated_at: new Date().toISOString(),
    execution_policy: "manual",
    endpoint: config.endpoint,
    actor: config.actor,
    targets: config.targets.map((target) => target.projectId),
    summary: {
      total: caseResults.length,
      passed,
      failed,
      overall: failed === 0 ? "PASS" : "FAIL"
    },
    cases: caseResults
  };
};

const summaryLine = (report: ManualSmokeReport): string =>
  [
    `SCN-020 manual smoke`,
    `overall=${report.summary.overall}`,
    `passed=${report.summary.passed}`,
    `failed=${report.summary.failed}`,
    `endpoint=${report.endpoint}`
  ].join(" | ");

const ensureManualMode = (argv: string[]): void => {
  if (!argv.includes("--manual")) {
    throw new Error("manual gate required: run with --manual");
  }
};

export const runCli = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
  dependencies: RunCliDependencies = {}
): Promise<ManualSmokeReport> => {
  ensureManualMode(argv);
  const config = parseManualSmokeConfig(env);
  const serviceFactory =
    dependencies.serviceFactory ??
    ((runtimeArgv: string[], runtimeEnv: NodeJS.ProcessEnv) =>
      buildAppwriteControlService({
        argv: runtimeArgv,
        env: runtimeEnv
      }));
  const io: CliIo = dependencies.io ?? {
    writeStdout: (line) => process.stdout.write(line),
    writeStderr: (line) => process.stderr.write(line)
  };

  const service = serviceFactory(argv, env);
  const report = await runManualSmokeSuite(service, config);
  io.writeStderr(`${summaryLine(report)}\n`);
  io.writeStdout(`${JSON.stringify(report, null, 2)}\n`);
  return report;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2), process.env).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[manual-smoke] failure: ${message}\n`);
    process.exit(1);
  });
}
