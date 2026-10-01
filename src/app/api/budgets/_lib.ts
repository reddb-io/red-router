import { effectiveSoftUsd, type Budget, type BudgetAssignment } from "@/lib/db/budgets";
import { getBudgetUsage } from "@/domain/budgetEngine";

/** The client view of a budget: definition, assignments and usage in the current window. */
export function serializeBudget(budget: Budget, assignments: readonly BudgetAssignment[]) {
  const usage = getBudgetUsage(budget);
  return {
    id: budget.id,
    name: budget.name,
    maxUsd: budget.maxUsd,
    softUsd: budget.softUsd,
    effectiveSoftUsd: effectiveSoftUsd(budget),
    duration: budget.duration,
    resetTime: budget.resetTime,
    onExceed: budget.onExceed,
    throttleDelayMs: budget.throttleDelayMs,
    tpmLimit: budget.tpmLimit,
    rpmLimit: budget.rpmLimit,
    modelMax: budget.modelMax,
    enabled: budget.enabled,
    createdAt: budget.createdAt,
    updatedAt: budget.updatedAt,
    keyIds: assignments.filter((a) => a.scopeType === "key").map((a) => a.scopeValue),
    groupIds: assignments.filter((a) => a.scopeType === "group").map((a) => a.scopeValue),
    tags: assignments.filter((a) => a.scopeType === "tag").map((a) => a.scopeValue),
    users: assignments.filter((a) => a.scopeType === "user").map((a) => a.scopeValue),
    usage: {
      spentUsd: usage.spentUsd,
      reservedUsd: usage.reservedUsd,
      windowStart: usage.windowStart > 0 ? new Date(usage.windowStart).toISOString() : null,
      resetAt: usage.resetAt === null ? null : new Date(usage.resetAt).toISOString(),
    },
  };
}

export function toAssignments(
  keyIds: readonly string[],
  groupIds: readonly string[],
  tags: readonly string[] = [],
  users: readonly string[] = []
) {
  return [
    ...keyIds.map((scopeValue) => ({ scopeType: "key" as const, scopeValue })),
    ...groupIds.map((scopeValue) => ({ scopeType: "group" as const, scopeValue })),
    ...tags.map((scopeValue) => ({ scopeType: "tag" as const, scopeValue })),
    ...users.map((scopeValue) => ({ scopeType: "user" as const, scopeValue })),
  ];
}

export const INVALID_JSON_BODY = {
  error: {
    message: "Invalid request",
    details: [{ field: "body", message: "Invalid JSON body" }],
  },
};
