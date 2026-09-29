import type { JobRegistry } from "@/lib/jobRegistry/registry";
import { runUsageSinksTick } from "@/lib/usageSinks/engine";

export const USAGE_SINKS_JOB_ID = "redrouter_usage_sinks";

export function registerUsageSinksJob(registry: JobRegistry): void {
  registry.register({
    id: USAGE_SINKS_JOB_ID,
    type: "interval",
    cron: null,
    intervalMs: 10_000,
    enabled: true,
    envFlag: null,
    config: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handler: async () => {
      const result = await runUsageSinksTick();
      return { success: true, recordsAffected: result.created + result.attempted };
    },
  });
}
