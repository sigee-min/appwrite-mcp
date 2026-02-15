import { AppwriteMcpError } from "../domain/errors.js";
import type {
  MutationTargetInput,
  ResolvedTarget,
  TargetSelectorInput
} from "../domain/types.js";

interface TargetResolverOptions {
  aliasMap: Record<string, string>;
  knownProjectIds: string[];
  autoTargetProjectIds?: string[];
  defaultTargetSelector?: TargetSelectorInput;
}

interface ResolveTargetInput {
  targets: MutationTargetInput[];
  targetSelector?: TargetSelectorInput;
}

interface ResolvedTargetsResult {
  resolvedTargets: ResolvedTarget[];
  source: "explicit" | "selector" | "auto";
}

export class TargetResolver {
  private readonly aliasMap: Record<string, string>;
  private readonly knownProjectIds: string[];
  private readonly autoTargetProjectIds: string[];
  private readonly defaultTargetSelector?: TargetSelectorInput;

  constructor(options: TargetResolverOptions) {
    this.aliasMap = options.aliasMap;
    this.knownProjectIds = [...options.knownProjectIds];
    this.autoTargetProjectIds = options.autoTargetProjectIds
      ? [...options.autoTargetProjectIds]
      : [];
    this.defaultTargetSelector = options.defaultTargetSelector;
  }

  getAliasCount(): number {
    return Object.keys(this.aliasMap).length;
  }

  getAutoTargetProjectIds(): string[] {
    return [...this.autoTargetProjectIds];
  }

  resolveRequest(input: ResolveTargetInput): ResolvedTargetsResult {
    if (input.targets.length > 0) {
      return {
        resolvedTargets: this.resolve(input.targets),
        source: "explicit"
      };
    }

    const selector = input.targetSelector ?? this.defaultTargetSelector;
    const selected = selector
      ? this.resolveFromSelector(selector)
      : this.resolveFromAuto();

    return {
      resolvedTargets: selected.map((projectId, index) => ({
        index,
        source: { project_id: projectId },
        project_id: projectId
      })),
      source: selector ? "selector" : "auto"
    };
  }

  resolve(targets: MutationTargetInput[]): ResolvedTarget[] {
    if (targets.length === 0) {
      throw new AppwriteMcpError("VALIDATION_ERROR", "targets[] is required", {
        target: "targets",
        operation_id: "*"
      });
    }

    return targets.map((target, index) => {
      const projectId = target.project_id;
      if (typeof projectId === "string" && projectId.length > 0) {
        return {
          index,
          source: target,
          project_id: projectId
        };
      }

      const alias = target.alias;
      const mappedProjectId =
        typeof alias === "string" ? this.aliasMap[alias] : undefined;
      if (typeof mappedProjectId === "string" && mappedProjectId.length > 0) {
        return {
          index,
          source: target,
          project_id: mappedProjectId
        };
      }

      throw new AppwriteMcpError(
        "TARGET_NOT_FOUND",
        `Unable to resolve target at index ${index}`,
        {
          target: target.alias ?? `index:${index}`,
          operation_id: "*"
        }
      );
    });
  }

  private resolveFromSelector(selector: TargetSelectorInput): string[] {
    const mode = selector.mode ?? "auto";

    if (mode === "project_id") {
      const values = this.selectorValues(selector);
      const matched = values.filter((value) => this.knownProjectIds.includes(value));
      return this.ensureNotEmpty(matched, "project_id selector did not match known targets");
    }

    if (mode === "alias") {
      const values = this.selectorValues(selector);
      const matched = values
        .map((alias) => this.aliasMap[alias])
        .filter((projectId): projectId is string =>
          typeof projectId === "string" && projectId.length > 0
        );
      return this.ensureNotEmpty(this.uniqueOrdered(matched), "alias selector did not match known targets");
    }

    return this.resolveFromAuto();
  }

  private resolveFromAuto(): string[] {
    if (this.autoTargetProjectIds.length > 0) {
      return this.uniqueOrdered(this.autoTargetProjectIds);
    }

    if (this.knownProjectIds.length === 1) {
      return [this.knownProjectIds[0] as string];
    }

    throw new AppwriteMcpError(
      "TARGET_AMBIGUOUS",
      "auto target resolution requires selector or configured auto targets",
      {
        target: "targets",
        operation_id: "*",
        remediation:
          "Provide targets[], provide target_selector, or configure defaults.auto_target_project_ids"
      }
    );
  }

  private selectorValues(selector: TargetSelectorInput): string[] {
    const values = [selector.value, ...(selector.values ?? [])]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    if (values.length > 0) {
      return this.uniqueOrdered(values);
    }

    throw new AppwriteMcpError("VALIDATION_ERROR", "target_selector requires value", {
      target: "target_selector",
      operation_id: "*"
    });
  }

  private ensureNotEmpty(values: string[], message: string): string[] {
    if (values.length > 0) {
      return values;
    }

    throw new AppwriteMcpError("TARGET_NOT_FOUND", message, {
      target: "targets",
      operation_id: "*"
    });
  }

  private uniqueOrdered(values: string[]): string[] {
    return [...new Set(values)];
  }
}
