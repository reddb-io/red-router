// Public protocol alias: keep both paths on the exact same implementation so
// authentication, validation, usage accounting, and errors cannot drift.
export const dynamic = "force-dynamic";

export { OPTIONS, POST } from "../systemone/route";
