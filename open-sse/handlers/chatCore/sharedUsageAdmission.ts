import {
  beginSharedUsageAttempt,
  settleSharedUsageAttempt,
  type SharedUsageAdmission,
  type SharedUsageAttempt,
} from "@/lib/usage/sharedUsageAdmission";

export type { SharedUsageAttempt } from "@/lib/usage/sharedUsageAdmission";

export type ChatSharedUsageAdmissionErrorKind = "denied" | "unavailable";

export class ChatSharedUsageAdmissionError extends Error {
  readonly kind: ChatSharedUsageAdmissionErrorKind;
  readonly status: number;
  readonly code: "budget_exceeded" | "admission_unavailable";

  constructor(kind: ChatSharedUsageAdmissionErrorKind) {
    super(
      kind === "denied"
        ? "The API key usage quota is exhausted"
        : "Concurrent usage accounting is temporarily unavailable"
    );
    this.name = "ChatSharedUsageAdmissionError";
    this.kind = kind;
    this.status = kind === "denied" ? 429 : 503;
    this.code = kind === "denied" ? "budget_exceeded" : "admission_unavailable";
  }
}

type AdmissionDeps = {
  begin?: typeof beginSharedUsageAttempt;
};

type SettlementDeps = {
  settle?: typeof settleSharedUsageAttempt;
};

export function requiresChatSharedUsageAdmission(apiKeyId: string | null | undefined): boolean {
  return (
    Boolean(apiKeyId) &&
    process.env.RED_ROUTER_PRODUCT_STRICT_QUOTAS === "1" &&
    process.env.RED_ROUTER_PRODUCT_CONCURRENT_QUOTAS === "1"
  );
}

/**
 * Reserve immediately before one real provider call. The callback observes the
 * durable reservation before `execute` starts so transport failures retain a
 * reconcilable dispatched row instead of accidentally releasing uncertain use.
 */
export async function executeWithChatSharedUsageAdmission<T>(
  args: {
    apiKeyId: string | null | undefined;
    provider: string;
    model: string;
    connectionId?: string | null;
    onReserved: (attempt: SharedUsageAttempt) => void;
    execute: () => Promise<T>;
  },
  deps: AdmissionDeps = {}
): Promise<T> {
  if (!requiresChatSharedUsageAdmission(args.apiKeyId)) return args.execute();

  const admission: SharedUsageAdmission = await (deps.begin ?? beginSharedUsageAttempt)(
    args.apiKeyId!,
    args.provider,
    args.model,
    args.connectionId
  );
  if (admission.state === "denied" || admission.state === "unavailable") {
    throw new ChatSharedUsageAdmissionError(admission.state);
  }
  if (admission.state === "reserved") args.onReserved(admission.attempt);
  return args.execute();
}

export function isChatSharedUsageAdmissionError(
  error: unknown
): error is ChatSharedUsageAdmissionError {
  return error instanceof ChatSharedUsageAdmissionError;
}

/**
 * Commit the completed provider usage exactly once. False deliberately means
 * the dispatched reservation remains for reconciliation; callers must still
 * suppress the legacy ledger/TPM writers to avoid double-accounting.
 */
export function trySettleChatSharedUsageAttempt(
  attempt: SharedUsageAttempt | null,
  usage: unknown,
  attribution?: {
    endUser?: string | null;
    tags?: readonly string[] | null;
    sessionId?: string | null;
  } | null,
  deps: SettlementDeps = {}
): boolean {
  if (!attempt || !usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  try {
    (deps.settle ?? settleSharedUsageAttempt)(
      attempt,
      usage as Record<string, number>,
      attribution
    );
    return true;
  } catch {
    return false;
  }
}
