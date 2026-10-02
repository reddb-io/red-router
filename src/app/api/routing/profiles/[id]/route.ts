import { mutateProfile } from "../_lib";

type Context = { params: Promise<{ id: string }> };
export async function PUT(request: Request, context: Context) {
  return mutateProfile(request, "save", (await context.params).id);
}
export async function DELETE(request: Request, context: Context) {
  return mutateProfile(request, "delete", (await context.params).id);
}
