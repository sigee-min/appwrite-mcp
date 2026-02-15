import type { AuditRecord } from "../domain/types.js";
import { redactSecrets } from "../domain/redaction.js";

export interface AuditLogger {
  append(record: AuditRecord): void;
  list(): AuditRecord[];
}

export class InMemoryAuditLogger implements AuditLogger {
  private readonly records: AuditRecord[] = [];

  append(record: AuditRecord): void {
    const details = redactSecrets(record.details);
    this.records.push({
      ...record,
      details: details && typeof details === "object"
        ? (details as Record<string, unknown>)
        : undefined
    });
  }

  list(): AuditRecord[] {
    return [...this.records];
  }
}
