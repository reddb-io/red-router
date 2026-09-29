// Bulk actions for the combos page: delete or change the strategy of many combos in one call,
// each combo reported on its own so one bad id never blocks the rest. Goes through the combos DB
// module, so the same invariants as a single edit apply. Quota-share combos are managed by
// their own feature and are never touched here.

import { deleteCombo, getComboById, updateCombo } from "@/lib/db/combos";
import { QUOTA_MODEL_PREFIX } from "@/lib/quota/quotaModelNaming";

export type ComboBulkAction = { action: "delete" } | { action: "setStrategy"; strategy: string };

export interface ComboBulkItemResult {
  id: string;
  status: "ok" | "not_found" | "skipped" | "failed";
  name?: string;
}

export interface ComboBulkResult {
  results: ComboBulkItemResult[];
  succeeded: number;
  failed: number;
}

export async function runComboBulk(
  ids: readonly string[],
  action: ComboBulkAction
): Promise<ComboBulkResult> {
  const results: ComboBulkItemResult[] = [];
  for (const id of new Set(ids)) {
    try {
      const combo = (await getComboById(id)) as { name?: string } | null;
      if (!combo) {
        results.push({ id, status: "not_found" });
        continue;
      }
      const name = typeof combo.name === "string" ? combo.name : undefined;
      if (name?.startsWith(QUOTA_MODEL_PREFIX)) {
        results.push({ id, name, status: "skipped" });
        continue;
      }
      const done =
        action.action === "delete"
          ? await deleteCombo(id)
          : Boolean(await updateCombo(id, { strategy: action.strategy }));
      results.push({ id, name, status: done ? "ok" : "failed" });
    } catch {
      results.push({ id, status: "failed" });
    }
  }
  const succeeded = results.filter((r) => r.status === "ok").length;
  return { results, succeeded, failed: results.filter((r) => r.status === "failed").length };
}
