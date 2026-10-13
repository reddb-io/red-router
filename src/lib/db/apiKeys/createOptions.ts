import type { ModelAccessMode } from "./modelAccessMode";
import type { UpsertKeyQuotaLimitsInput } from "../keyQuota";

export interface CreateApiKeyOptions {
  modelAccessMode?: ModelAccessMode;
  allowedModels?: string[];
  allowedCombos?: string[];
  allowedConnections?: string[];
  expiresAt?: string | null;
  /** Inserted in the same SQLite transaction as the bearer key. */
  quotaLimits?: UpsertKeyQuotaLimitsInput;
  tags?: readonly string[];
  /** Immutable operator metadata attached to every usage event for this key. */
  usageAttributes?: import("@/lib/usage/reportingAttributes").UsageAttributes;
  modelIdFormat?: "prefixed" | "flat";
}
