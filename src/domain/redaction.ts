const SECRET_KEY_PATTERN = /(token|secret|api[_-]?key|password|credential|authorization)/i;
const SECRET_VALUE_PATTERN = /(sk_[a-z0-9]{8,}|bearer\s+[a-z0-9._-]+)/i;
const REDACTED = "[REDACTED]";

const redactString = (value: string): string => {
  if (SECRET_VALUE_PATTERN.test(value)) {
    return REDACTED;
  }

  return value;
};

export const redactSecrets = (value: unknown): unknown => {
  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry));
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, entry]) => {
        if (SECRET_KEY_PATTERN.test(key)) {
          return [key, REDACTED] as const;
        }

        return [key, redactSecrets(entry)] as const;
      }
    );

    return Object.fromEntries(entries);
  }

  return value;
};
