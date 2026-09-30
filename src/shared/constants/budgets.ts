/** Vocabulary of the reusable budgets (db/budgets, domain/budgetEngine, validation, dashboard). */

export const BUDGET_DURATIONS = ["daily", "weekly", "monthly", "total"] as const;
export type BudgetDuration = (typeof BUDGET_DURATIONS)[number];

export const BUDGET_ON_EXCEED = ["block", "throttle"] as const;
export type BudgetOnExceed = (typeof BUDGET_ON_EXCEED)[number];

/**
 * What a budget can be assigned to: an API key, a key group (team), a request tag or an end user
 * (the OpenAI `user` field / `x-red-router-end-user` header).
 */
export const BUDGET_SCOPE_TYPES = ["key", "group", "tag", "user"] as const;
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPES)[number];

/** Soft threshold used when a budget does not set one. */
export const DEFAULT_SOFT_RATIO = 0.8;

/** Length of the rate-limit bucket (tokens / requests per minute) — the key quota's window. */
export const BUDGET_RATE_WINDOW_MS = 60_000;

/** Largest tpm / rpm a budget can carry (a sanity bound, not a product limit). */
export const BUDGET_RATE_LIMIT_MAX = 1_000_000_000;

/** Per-model caps: entries a budget may carry and the longest model key. */
export const BUDGET_MODEL_CAPS_MAX = 100;
export const BUDGET_MODEL_KEY_MAX = 200;

/** "<provider>/<model>", a bare "<model>" or "<provider>/*". */
export const BUDGET_MODEL_KEY_REGEX = /^[A-Za-z0-9][\w.:@+\-/]*(?:\/\*)?$/;
