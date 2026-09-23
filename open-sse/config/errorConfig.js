export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "permission_denied" },
  404: { type: "not_found_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  409: { type: "invalid_request_error", code: "conflict" },
  413: { type: "request_too_large", code: "request_too_large" },
  422: { type: "invalid_request_error", code: "unprocessable_entity" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "api_error", code: "internal_server_error" },
  502: { type: "api_error", code: "bad_gateway" },
  503: { type: "api_error", code: "service_unavailable" },
  504: { type: "api_error", code: "gateway_timeout" },
  529: { type: "overloaded_error", code: "overloaded" },
};

export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "Permission denied",
  404: "Model not found",
  406: "Model not supported",
  409: "Request conflict",
  413: "Request too large",
  422: "Unprocessable entity",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout",
  529: "Service overloaded",
};

export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15,
};

export const TRANSIENT_COOLDOWN_MS = 30 * 1000;
// The first 5xx after a success locks the model this long instead of the full
// transient cooldown; repeats escalate. One upstream blip should not cost 30 s.
export const FIRST_5XX_COOLDOWN_MS = 5 * 1000;
export const MAX_RATE_LIMIT_COOLDOWN_MS = 8 * 24 * 60 * 60 * 1000;

const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
  quotaWindow: 60 * 60 * 1000,
};

export const ERROR_RULES = [
  { text: "request not allowed", cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  // Terminal billing/credit states. These arrive as 429 from some providers
  // (Z.AI/GLM code 1113 is a Chinese-language "insufficient balance" body), so
  // without an explicit rule they fall through to the generic 429 backoff and
  // get retried forever against an account that cannot recover without a
  // top-up. Verified live 2026-09-18: GLM returns
  //   {"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}
  // Matched before the rate-limit rules so a balance error never looks transient.
  { text: "余额不足",                  cooldownMs: COOLDOWN.long, terminal: true },
  { text: "insufficient balance",     cooldownMs: COOLDOWN.long, terminal: true },
  { text: "请充值",                    cooldownMs: COOLDOWN.long, terminal: true },

  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "monthly_request_count",     cooldownMs: COOLDOWN.quotaWindow },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long, terminal: true },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
