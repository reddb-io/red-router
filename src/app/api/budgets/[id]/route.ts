import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { deleteBudget, getBudgetAssignments, getBudgetById, updateBudget } from "@/lib/db/budgets";
import { SOFT_ABOVE_MAX_MESSAGE, updateBudgetSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { INVALID_JSON_BODY, serializeBudget } from "../_lib";

type RouteParams = { params: Promise<{ id: string }> };

const NOT_FOUND = { error: "Budget not found" };

/** GET /api/budgets/[id] — one budget with assignments and current-window usage. */
export async function GET(request: Request, { params }: RouteParams) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const budget = getBudgetById(id);
    if (!budget) return NextResponse.json(NOT_FOUND, { status: 404 });
    return NextResponse.json({ budget: serializeBudget(budget, getBudgetAssignments(id)) });
  } catch {
    return NextResponse.json({ error: "Failed to get budget" }, { status: 500 });
  }
}

/** PATCH /api/budgets/[id] — change any of the budget's own fields. */
export async function PATCH(request: Request, { params }: RouteParams) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(INVALID_JSON_BODY, { status: 400 });
  }

  const validation = validateBody(updateBudgetSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const { id } = await params;
    const existing = getBudgetById(id);
    if (!existing) return NextResponse.json(NOT_FOUND, { status: 404 });

    // A partial change can break the invariant against the stored value (lower max, same soft).
    const maxUsd = validation.data.maxUsd ?? existing.maxUsd;
    const softUsd =
      validation.data.softUsd !== undefined ? validation.data.softUsd : existing.softUsd;
    if (softUsd !== null && softUsd > maxUsd) {
      return NextResponse.json(
        {
          error: {
            message: "Invalid request",
            details: [{ field: "softUsd", message: SOFT_ABOVE_MAX_MESSAGE }],
          },
        },
        { status: 400 }
      );
    }

    const budget = updateBudget(id, validation.data);
    if (!budget) return NextResponse.json(NOT_FOUND, { status: 404 });
    return NextResponse.json({ budget: serializeBudget(budget, getBudgetAssignments(id)) });
  } catch {
    return NextResponse.json({ error: "Failed to update budget" }, { status: 500 });
  }
}

/** DELETE /api/budgets/[id] — remove the budget with its assignments and spend history. */
export async function DELETE(request: Request, { params }: RouteParams) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    if (!deleteBudget(id)) return NextResponse.json(NOT_FOUND, { status: 404 });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete budget" }, { status: 500 });
  }
}
