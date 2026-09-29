/** Vocabulary of the reusable budgets (db/budgets, domain/budgetEngine, validation, dashboard). */

export const BUDGET_DURATIONS = ["daily", "weekly", "monthly", "total"] as const;
export type BudgetDuration = (typeof BUDGET_DURATIONS)[number];

export const BUDGET_ON_EXCEED = ["block", "throttle"] as const;
export type BudgetOnExceed = (typeof BUDGET_ON_EXCEED)[number];

export const BUDGET_SCOPE_TYPES = ["key", "group"] as const;
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPES)[number];

/** Soft threshold used when a budget does not set one. */
export const DEFAULT_SOFT_RATIO = 0.8;
