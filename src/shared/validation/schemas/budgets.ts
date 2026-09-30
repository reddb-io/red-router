import { z } from "zod";
import {
  BUDGET_DURATIONS,
  BUDGET_MODEL_CAPS_MAX,
  BUDGET_MODEL_KEY_MAX,
  BUDGET_MODEL_KEY_REGEX,
  BUDGET_ON_EXCEED,
  BUDGET_RATE_LIMIT_MAX,
} from "@/shared/constants/budgets";
import {
  END_USER_MAX_LENGTH,
  normalizeEndUser,
  normalizeTag,
  TAG_MAX_LENGTH,
} from "@/shared/constants/attribution";

// ──── Reusable budgets ────

/** HH:MM (UTC), 00:00 to 23:59. */
const resetTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "resetTime must be HH:MM (UTC)");

const idListSchema = z.array(z.string().trim().min(1).max(200)).max(500);

/** Tags are stored lowercased and at most 32 characters; control characters are refused. */
const tagListSchema = z
  .array(
    z
      .string()
      .max(TAG_MAX_LENGTH, `A tag is at most ${TAG_MAX_LENGTH} characters`)
      .transform((value) => normalizeTag(value))
      .refine((value): value is string => value !== null, "A tag must not be empty")
  )
  .max(500);

/** End-user ids are stored as sent (trimmed, control characters removed), at most 128 characters. */
const userListSchema = z
  .array(
    z
      .string()
      .max(END_USER_MAX_LENGTH, `An end user is at most ${END_USER_MAX_LENGTH} characters`)
      .transform((value) => normalizeEndUser(value))
      .refine((value): value is string => value !== null, "An end user must not be empty")
  )
  .max(500);

const rateLimitSchema = z
  .number()
  .int("Rate limits are whole numbers")
  .positive("Rate limits must be greater than 0")
  .max(BUDGET_RATE_LIMIT_MAX);

const modelMaxSchema = z
  .record(
    z
      .string()
      .max(BUDGET_MODEL_KEY_MAX)
      .regex(BUDGET_MODEL_KEY_REGEX, "Model keys look like provider/model, model or provider/*"),
    z.number().positive("Model caps must be greater than 0").finite()
  )
  .refine((value) => Object.keys(value).length <= BUDGET_MODEL_CAPS_MAX, {
    message: `At most ${BUDGET_MODEL_CAPS_MAX} model caps`,
  });

const budgetFields = {
  name: z.string().trim().min(1, "Name is required").max(80),
  maxUsd: z.number().positive("maxUsd must be greater than 0").finite(),
  softUsd: z.number().positive("softUsd must be greater than 0").finite().nullable(),
  duration: z.enum(BUDGET_DURATIONS),
  resetTime: resetTimeSchema.nullable(),
  onExceed: z.enum(BUDGET_ON_EXCEED),
  throttleDelayMs: z.number().int().min(0).max(300_000),
  tpmLimit: rateLimitSchema.nullable(),
  rpmLimit: rateLimitSchema.nullable(),
  modelMax: modelMaxSchema,
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
    tpmLimit: budgetFields.tpmLimit.optional(),
    rpmLimit: budgetFields.rpmLimit.optional(),
    modelMax: budgetFields.modelMax.optional(),
    enabled: budgetFields.enabled.default(true),
    keyIds: idListSchema.optional(),
    groupIds: idListSchema.optional(),
    tags: tagListSchema.optional(),
    users: userListSchema.optional(),
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
    tpmLimit: budgetFields.tpmLimit.optional(),
    rpmLimit: budgetFields.rpmLimit.optional(),
    modelMax: budgetFields.modelMax.optional(),
    enabled: budgetFields.enabled.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required")
  .refine(softWithinMax, { message: SOFT_ABOVE_MAX_MESSAGE, path: ["softUsd"] });

export const replaceBudgetAssignmentsSchema = z
  .object({
    keyIds: idListSchema.default([]),
    groupIds: idListSchema.default([]),
    // Omitted = keep the current tag / end-user assignments (a slice-1 client only knows keys/groups).
    tags: tagListSchema.optional(),
    users: userListSchema.optional(),
  })
  .strict();
