import { readFileSync } from "node:fs";
import { AppwriteControlService } from "../core/appwrite-control-service.js";
import { InMemoryAuditLogger } from "../core/audit-log.js";
import { HttpAppwriteAdapter } from "../adapters/http-appwrite-adapter.js";
import type {
  AuthContext,
  ProjectAuthEntry,
  ProjectAuthFile,
  TargetSelectorInput,
  TransportName
} from "../domain/types.js";
import { z } from "zod";

export interface RuntimeBuildInput {
  argv: string[];
  env: NodeJS.ProcessEnv;
}

export interface RuntimeServerConfig {
  transport: "stdio" | "streamable-http";
  streamableHttpHost: string;
  streamableHttpPort: number;
  streamableHttpPath: string;
}

const DEFAULT_CONFIRM_SECRET = "appwrite-mcp-dev-secret";

const parseBoolean = (value: string | undefined): boolean =>
  value === "1" || value === "true" || value === "yes";

const parseAliases = (rawAliases: string | undefined): Record<string, string> => {
  if (!rawAliases) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawAliases) as Record<string, unknown>;
    const aliases: Record<string, string> = {};

    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.length > 0) {
        aliases[key] = value;
      }
    }

    return aliases;
  } catch {
    return {};
  }
};

const parseTransportArgument = (argv: string[]): TransportName | undefined => {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }

    if (token === "--transport" && argv[index + 1]) {
      return argv[index + 1] as TransportName;
    }

    if (token.startsWith("--transport=")) {
      return token.substring("--transport=".length) as TransportName;
    }
  }

  return undefined;
};

const parsePort = (value: string | undefined): number => {
  if (!value || value.trim().length === 0) {
    return 8080;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("APPWRITE_MCP_HTTP_PORT must be an integer between 1 and 65535");
  }

  return parsed;
};

const normalizeHttpPath = (value: string | undefined): string => {
  if (!value || value.trim().length === 0) {
    return "/mcp";
  }

  const trimmed = value.trim();
  if (trimmed === "/") {
    return "/";
  }

  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
};

export const resolveRuntimeServerConfig = (
  input: RuntimeBuildInput
): RuntimeServerConfig => {
  const requestedTransport =
    parseTransportArgument(input.argv) ??
    (input.env.APPWRITE_MCP_TRANSPORT as TransportName | undefined);

  const selectedTransport = requestedTransport ?? "stdio";
  if (selectedTransport !== "stdio" && selectedTransport !== "streamable-http") {
    throw new Error(`Unsupported startup transport: ${selectedTransport}`);
  }

  const transport = selectedTransport as RuntimeServerConfig["transport"];

  if (
    transport === "streamable-http" &&
    !parseBoolean(input.env.APPWRITE_MCP_ENABLE_STREAMABLE_HTTP)
  ) {
    throw new Error(
      "streamable-http transport requires APPWRITE_MCP_ENABLE_STREAMABLE_HTTP=true"
    );
  }

  const streamableHttpHost = input.env.APPWRITE_MCP_HTTP_HOST?.trim() || "127.0.0.1";
  const streamableHttpPort = parsePort(input.env.APPWRITE_MCP_HTTP_PORT);
  const streamableHttpPath = normalizeHttpPath(input.env.APPWRITE_MCP_HTTP_PATH);

  if (
    transport === "streamable-http" &&
    streamableHttpHost !== "127.0.0.1" &&
    streamableHttpHost !== "localhost" &&
    streamableHttpHost !== "::1" &&
    !parseBoolean(input.env.APPWRITE_MCP_ALLOW_REMOTE_HTTP)
  ) {
    throw new Error(
      "remote streamable-http host requires APPWRITE_MCP_ALLOW_REMOTE_HTTP=true"
    );
  }

  return {
    transport,
    streamableHttpHost,
    streamableHttpPort,
    streamableHttpPath
  };
};

const projectAuthEntrySchema = z.object({
  api_key: z.string().min(1),
  scopes: z.array(z.string().min(1)),
  endpoint: z.string().min(1).optional(),
  aliases: z.array(z.string().min(1)).optional(),
  default_for_auto: z.boolean().optional(),
  display_name: z.string().min(1).optional()
});

const targetSelectorSchema = z.object({
  mode: z.enum(["auto", "alias", "project_id"]).optional(),
  value: z.string().min(1).optional(),
  values: z.array(z.string().min(1)).optional()
});

const projectAuthFileSchema = z.object({
  default_endpoint: z.string().min(1),
  projects: z
    .record(projectAuthEntrySchema)
    .refine((projects) => Object.keys(projects).length > 0, {
      message: "projects must include at least one project entry"
    }),
  defaults: z
    .object({
      auto_target_project_ids: z.array(z.string().min(1)).optional(),
      target_selector: targetSelectorSchema.optional()
    })
    .optional()
});

interface LoadedProjectAuthContexts {
  fallbackAuthContext: AuthContext;
  projectAuthContexts: Record<string, AuthContext>;
  fileAliases: Record<string, string>;
  knownProjectIds: string[];
  autoTargetProjectIds: string[];
  defaultTargetSelector?: TargetSelectorInput;
}

const toAuthContext = (
  defaultEndpoint: string,
  entry: ProjectAuthEntry
): AuthContext => ({
  endpoint: entry.endpoint ?? defaultEndpoint,
  api_key: entry.api_key,
  scopes: [...entry.scopes]
});

const readProjectAuthFile = (filePath: string): LoadedProjectAuthContexts => {
  let rawText: string;
  try {
    rawText = readFileSync(filePath, "utf8");
  } catch {
    throw new Error("APPWRITE_PROJECT_AUTH_FILE read failed");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText) as unknown;
  } catch {
    throw new Error("APPWRITE_PROJECT_AUTH_FILE must contain valid JSON");
  }

  const parsed = projectAuthFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "root";
    const reason = issue?.message ?? "invalid schema";
    throw new Error(
      `APPWRITE_PROJECT_AUTH_FILE schema invalid at ${path}: ${reason}`
    );
  }

  const authFile = parsed.data as ProjectAuthFile;
  const projectAuthContexts: Record<string, AuthContext> = {};
  const fileAliases: Record<string, string> = {};
  const autoCandidates: string[] = [];

  for (const [projectId, entry] of Object.entries(authFile.projects)) {
    projectAuthContexts[projectId] = toAuthContext(
      authFile.default_endpoint,
      entry
    );

    for (const alias of entry.aliases ?? []) {
      fileAliases[alias] = projectId;
    }

    if (entry.default_for_auto) {
      autoCandidates.push(projectId);
    }
  }

  const fallbackEntry = Object.values(authFile.projects)[0];
  if (!fallbackEntry) {
    throw new Error("APPWRITE_PROJECT_AUTH_FILE has no project entries");
  }

  const knownProjectIds = Object.keys(authFile.projects);
  const autoTargetProjectIds =
    authFile.defaults?.auto_target_project_ids &&
    authFile.defaults.auto_target_project_ids.length > 0
      ? [...authFile.defaults.auto_target_project_ids]
      : autoCandidates;

  for (const projectId of autoTargetProjectIds) {
    if (!knownProjectIds.includes(projectId)) {
      throw new Error(
        `APPWRITE_PROJECT_AUTH_FILE defaults.auto_target_project_ids includes unknown project: ${projectId}`
      );
    }
  }

  for (const [alias, projectId] of Object.entries(fileAliases)) {
    if (!knownProjectIds.includes(projectId)) {
      throw new Error(
        `APPWRITE_PROJECT_AUTH_FILE alias '${alias}' points to unknown project: ${projectId}`
      );
    }
  }

  return {
    fallbackAuthContext: toAuthContext(authFile.default_endpoint, fallbackEntry),
    projectAuthContexts,
    fileAliases,
    knownProjectIds,
    autoTargetProjectIds,
    defaultTargetSelector: authFile.defaults?.target_selector
      ? {
          mode: authFile.defaults.target_selector.mode,
          value: authFile.defaults.target_selector.value,
          values: authFile.defaults.target_selector.values
            ? [...authFile.defaults.target_selector.values]
            : undefined
        }
      : undefined
  };
};

export const buildAppwriteControlService = (
  input: RuntimeBuildInput
): AppwriteControlService => {
  const authFilePath = input.env.APPWRITE_PROJECT_AUTH_FILE;
  if (!authFilePath || authFilePath.trim().length === 0) {
    throw new Error("APPWRITE_PROJECT_AUTH_FILE is required");
  }
  const loadedAuth = readProjectAuthFile(authFilePath);

  const requestedTransport =
    parseTransportArgument(input.argv) ??
    (input.env.APPWRITE_MCP_TRANSPORT as TransportName | undefined);

  const supportedTransports: TransportName[] = ["stdio"];
  if (parseBoolean(input.env.APPWRITE_MCP_ENABLE_STREAMABLE_HTTP)) {
    supportedTransports.push("streamable-http");
  }

  const confirmationSecret =
    input.env.APPWRITE_MCP_CONFIRM_SECRET ?? DEFAULT_CONFIRM_SECRET;
  if (input.env.NODE_ENV === "production" && confirmationSecret === DEFAULT_CONFIRM_SECRET) {
    throw new Error(
      "APPWRITE_MCP_CONFIRM_SECRET is required in production and must not use default"
    );
  }

  return new AppwriteControlService({
    adapter: new HttpAppwriteAdapter(),
    auditLogger: new InMemoryAuditLogger(),
    authContext: loadedAuth.fallbackAuthContext,
    projectAuthContexts: loadedAuth.projectAuthContexts,
    knownProjectIds: loadedAuth.knownProjectIds,
    autoTargetProjectIds: loadedAuth.autoTargetProjectIds,
    defaultTargetSelector: loadedAuth.defaultTargetSelector,
    confirmationSecret,
    aliasMap: {
      ...loadedAuth.fileAliases,
      ...parseAliases(input.env.APPWRITE_MCP_TARGET_ALIASES)
    },
    projectManagementAvailable: parseBoolean(
      input.env.APPWRITE_MCP_ENABLE_PROJECT_MANAGEMENT
    ),
    transportDefault: "stdio",
    supportedTransports,
    requestedTransport
  });
};
