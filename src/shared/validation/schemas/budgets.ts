import { z } from "zod";
import { BUDGET_DURATIONS, BUDGET_ON_EXCEED } from "@/shared/constants/budgets";

// ──── Reusable budgets ────

/** HH:MM (UTC), 00:00 to 23:59. */
const resetTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "resetTime must be HH:MM (UTC)");

const idListSchema = z.array(z.string().trim().min(1).max(200)).max(500);

const budgetFields = {
  name: z.string().trim().min(1, "Name is required").max(80),
  maxUsd: z.number().positive("maxUsd must be greater than 0").finite(),
  softUsd: z.number().positive("softUsd must be greater than 0").finite().nullable(),
  duration: z.enum(BUDGET_DURATIONS),
  resetTime: resetTimeSchema.nullable(),
  onExceed: z.enum(BUDGET_ON_EXCEED),
  throttleDelayMs: z.number().int().min(0).max(300_000),
  enabled: z.boolean(),
};

export const SOFT_ABOVE_MAX_MESSAGE = "softUsd must not exceed maxUsd";

const softWithinMax = (value: { maxUsd?: number; softUsd?: number | null }) =>
  value.softUsd == null || value.maxUsd == null || value.softUsd <= value.maxUsd;

export const createBudgetSchema = z
  .object({
    name: budgetFields.name,
    maxUsd: budgetFields.maxUsd,
    softUsd: budgetFields.softUsd.optional(),
    duration: budgetFields.duration.default("monthly"),
    resetTime: budgetFields.resetTime.optional(),
    onExceed: budgetFields.onExceed.default("block"),
    throttleDelayMs: budgetFields.throttleDelayMs.default(1000),
    enabled: budgetFields.enabled.default(true),
    keyIds: idListSchema.optional(),
    groupIds: idListSchema.optional(),
  })
  .strict()
  .refine(softWithinMax, { message: SOFT_ABOVE_MAX_MESSAGE, path: ["softUsd"] });

export const updateBudgetSchema = z
  .object({
    name: budgetFields.name.optional(),
    maxUsd: budgetFields.maxUsd.optional(),
    softUsd: budgetFields.softUsd.optional(),
    duration: budgetFields.duration.optional(),
    resetTime: budgetFields.resetTime.optional(),
    onExceed: budgetFields.onExceed.optional(),
    throttleDelayMs: budgetFields.throttleDelayMs.optional(),
    enabled: budgetFields.enabled.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required")
  .refine(softWithinMax, { message: SOFT_ABOVE_MAX_MESSAGE, path: ["softUsd"] });

export const replaceBudgetAssignmentsSchema = z
  .object({
    keyIds: idListSchema.default([]),
    groupIds: idListSchema.default([]),
  })
  .strict();
