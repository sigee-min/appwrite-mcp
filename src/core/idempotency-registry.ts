import type { TargetOperationResult } from "../domain/types.js";

export class IdempotencyRegistry {
  private readonly results = new Map<string, TargetOperationResult>();

  get(key: string): TargetOperationResult | undefined {
    return this.results.get(key);
  }

  set(key: string, result: TargetOperationResult): void {
    this.results.set(key, result);
  }
}
