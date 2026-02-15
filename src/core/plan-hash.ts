import { createHash } from "node:crypto";
import { canonicalStringify } from "./canonical-json.js";

export const createPlanHash = (value: unknown): string =>
  createHash("sha256").update(canonicalStringify(value)).digest("hex");
