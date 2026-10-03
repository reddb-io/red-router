import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/errorSanitization.ts";
import { deleteCallLogsBefore } from "@/lib/usage/callLogs";

import { getDbInstance } from "./core";
import { tableExists } from "./cleanup/usagePurge";
import { getHistoryWindowDays, type HistoryWindowDays } from "./historyRetentionPolicy";

const BATCH = 1000;
const MAX_BATCHES = 20;

// Only operational event tables. Credentials, users, tenants, keys, quotas,
// memories, pending deliveries and the financial ledger are never purge targets.
const TARGETS = [
  ["request_detail_logs", "timestamp", "iso"],
  ["proxy_logs", "timestamp", "iso"],
  ["audit_log", "timestamp", "iso"],
  ["mcp_tool_audit", "created_at", "iso"],
  ["config_audit_log", "timestamp", "iso"],
  ["middleware_logs", "timestamp", "iso"],
  ["routing_decisions", "created_at", "iso"],
  ["compression_analytics", "timestamp", "iso"],
  ["compression_engine_breakdown", "timestamp", "iso"],
  ["compression_run_telemetry", "timestamp", "epoch"],
  ["quota_snapshots", "created_at", "iso"],
  ["relay_logs", "created_at", "seconds"],
  ["job_runs", "started_at", "iso"],
] as const;

export async function cleanupSqliteHistory(days: HistoryWindowDays, now = Date.now()) {
  const results: Record<string, { deleted: number; errors: number }> = {};
  if (!days) return { totalDeleted: 0, totalErrors: 0, results };
  // Re-read between batches so saving Off or a longer window stops this pass.
  const policyUnchanged = () => getHistoryWindowDays() === days;
  const cutoffMs = now - days * 86_400_000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  if (tableExists("call_logs")) {
    results.call_logs = { deleted: 0, errors: 0 };
    try {
      for (let i = 0; i < MAX_BATCHES && policyUnchanged(); i++) {
        const batch = deleteCallLogsBefore(cutoffIso, BATCH);
        results.call_logs.deleted += batch.deletedRows;
        if (batch.deletedRows < BATCH) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      results.call_logs.errors++;
      console.error(
        "[Cleanup] SQLite history cleanup failed for call_logs:",
        sanitizeErrorMessage(error)
      );
    }
  }
  for (const [table, column, format] of TARGETS) {
    if (!policyUnchanged()) break;
    if (!tableExists(table)) continue;
    const result = (results[table] = { deleted: 0, errors: 0 });
    try {
      // julianday accepts both SQLite's space-separated dates and ISO timestamps.
      const condition = format === "iso" ? `julianday(${column}) < julianday(?)` : `${column} < ?`;
      const cutoff =
        format === "seconds"
          ? Math.floor(cutoffMs / 1000)
          : format === "epoch"
            ? cutoffMs
            : cutoffIso;
      const liveGuard = table === "job_runs" ? "AND status != 'running'" : "";
      const statement = getDbInstance().prepare(`DELETE FROM ${table} WHERE rowid IN (
        SELECT rowid FROM ${table} WHERE ${condition} ${liveGuard} LIMIT ?
      )`);
      for (let i = 0; i < MAX_BATCHES && policyUnchanged(); i++) {
        const count = statement.run(cutoff, BATCH).changes;
        result.deleted += count;
        if (count < BATCH) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      result.errors++;
      console.error(
        `[Cleanup] SQLite history cleanup failed for ${table}:`,
        sanitizeErrorMessage(error)
      );
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const totalDeleted = Object.values(results).reduce((sum, result) => sum + result.deleted, 0);
  const totalErrors = Object.values(results).reduce((sum, result) => sum + result.errors, 0);
  console.info(
    `[Cleanup] SQLite ${days}-day history window: ${totalDeleted} deleted, ${totalErrors} errors.`
  );
  return { totalDeleted, totalErrors, results };
}
