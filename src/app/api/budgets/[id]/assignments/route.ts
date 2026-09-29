import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getBudgetAssignments, getBudgetById, replaceBudgetAssignments } from "@/lib/db/budgets";
import { replaceBudgetAssignmentsSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { INVALID_JSON_BODY, toAssignments } from "../../_lib";

type RouteParams = { params: Promise<{ id: string }> };

const NOT_FOUND = { error: "Budget not found" };

function view(budgetId: string) {
  const assignments = getBudgetAssignments(budgetId);
  return {
    keyIds: assignments.filter((a) => a.scopeType === "key").map((a) => a.scopeValue),
    groupIds: assignments.filter((a) => a.scopeType === "group").map((a) => a.scopeValue),
  };
}

/** GET /api/budgets/[id]/assignments — the API keys and key groups the budget applies to. */
export async function GET(request: Request, { params }: RouteParams) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    if (!getBudgetById(id)) return NextResponse.json(NOT_FOUND, { status: 404 });
    return NextResponse.json(view(id));
  } catch {
    return NextResponse.json({ error: "Failed to get assignments" }, { status: 500 });
  }
}

/** PUT /api/budgets/[id]/assignments — replace the whole assignment set. */
export async function PUT(request: Request, { params }: RouteParams) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(INVALID_JSON_BODY, { status: 400 });
  }

  const validation = validateBody(replaceBudgetAssignmentsSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const { id } = await params;
    if (!getBudgetById(id)) return NextResponse.json(NOT_FOUND, { status: 404 });
    replaceBudgetAssignments(id, toAssignments(validation.data.keyIds, validation.data.groupIds));
    return NextResponse.json(view(id));
  } catch {
    return NextResponse.json({ error: "Failed to replace assignments" }, { status: 500 });
  }
}
