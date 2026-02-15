const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }

  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const output: Record<string, unknown> = {};

    for (const key of keys) {
      output[key] = normalize((value as Record<string, unknown>)[key]);
    }

    return output;
  }

  return value;
};

export const canonicalStringify = (value: unknown): string =>
  JSON.stringify(normalize(value));
