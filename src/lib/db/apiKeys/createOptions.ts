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
  modelIdFormat?: "prefixed" | "flat";
}
