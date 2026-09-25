import { NextResponse } from "next/server";
import { getUsageSinkById, updateUsageSink, deleteUsageSink } from "@/lib/db/repos/usageSinksRepo.js";
import { parseSinkInput, publicSink } from "@/lib/usageSinks/input.js";

// PUT /api/usage-sinks/{id} — partial update; an empty secret keeps the stored one.
export async function PUT(request, { params }) {
  const { id } = await params;
  const existing = await getUsageSinkById(id);
  if (!existing) return NextResponse.json({ error: "Sink not found" }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  const { value, error } = parseSinkInput(body, existing);
  if (error) return NextResponse.json({ error }, { status: 400 });
  return NextResponse.json({ sink: publicSink(await updateUsageSink(id, value)) });
}

// DELETE /api/usage-sinks/{id} — removes the sink and its delivery history.
export async function DELETE(_request, { params }) {
  const { id } = await params;
  if (!(await getUsageSinkById(id))) return NextResponse.json({ error: "Sink not found" }, { status: 404 });
  await deleteUsageSink(id);
  return NextResponse.json({ ok: true });
}
