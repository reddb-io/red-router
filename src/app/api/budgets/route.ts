import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  createBudget,
  getAllBudgetAssignments,
  listBudgets,
  replaceBudgetAssignments,
  getBudgetAssignments,
} from "@/lib/db/budgets";
import { createBudgetSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { INVALID_JSON_BODY, serializeBudget, toAssignments } from "./_lib";

/** GET /api/budgets — every budget with its assignments and current-window usage. */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const assignments = getAllBudgetAssignments();
    const budgets = listBudgets().map((budget) =>
      serializeBudget(budget, assignments.get(budget.id) ?? [])
    );
    return NextResponse.json({ budgets });
  } catch {
    return NextResponse.json({ error: "Failed to list budgets" }, { status: 500 });
  }
}

/** POST /api/budgets — create a budget, optionally with its assignments. */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(INVALID_JSON_BODY, { status: 400 });
  }

  const validation = validateBody(createBudgetSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const { keyIds, groupIds, ...fields } = validation.data;
    const budget = createBudget(fields);
    if (keyIds?.length || groupIds?.length) {
      replaceBudgetAssignments(budget.id, toAssignments(keyIds ?? [], groupIds ?? []));
    }
    return NextResponse.json(
      { budget: serializeBudget(budget, getBudgetAssignments(budget.id)) },
      { status: 201 }
    );
  } catch {
    return NextResponse.json({ error: "Failed to create budget" }, { status: 500 });
  }
}
