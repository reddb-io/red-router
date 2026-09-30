/**
 * Backlog snapshot behind GET /api/system/backlog. Computed on demand from counters and
 * tables that already exist; nothing here instruments the request path.
 *
 * Reused sources:
 *  - in-flight requests: `getActiveRequestCount()` (gracefulShutdown.ts), the admission-lease
 *    counter that already gates the SIGTERM drain
 *  - chat admission queue: `perConnectionAdmissionController.snapshot()`
 *  - usage-sink outbox: `getUsageDeliveryStats()` (redrouter_usage_deliveries)
 *  - log export: `countCallLogsAfterRowId(cursor)` per enabled destination
 * Webhook deliveries have no queue (they are dispatched inline with bounded retries), so
 * there is no depth to report for them.
 */

import { getActiveRequestCount, isDraining } from "@/lib/gracefulShutdown";
import { getManualDrainState, type ManualDrainState } from "./drainMode";

export interface BacklogSnapshot {
  generatedAt: string;
  draining: ManualDrainState & { shuttingDown: boolean };
  inFlight: { requests: number };
  chatAdmission: {
    activeHeavy: number;
    waiting: number;
    queuedBytes: number;
    shedTotal: number;
  } | null;
  usageSinks: { pending: number; dead: number; sinks: number } | null;
  logExport: {
    pending: number;
    destinations: Array<{ id: string; name: string; type: string; pending: number }>;
  } | null;
}

async function section<T>(read: () => Promise<T> | T): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

export async function collectBacklog(now: Date = new Date()): Promise<BacklogSnapshot> {
  const chatAdmission = await section(async () => {
    const { perConnectionAdmissionController } =
      await import("@/shared/middleware/chatBodyAdmission");
    const snapshot = perConnectionAdmissionController.snapshot();
    return {
      activeHeavy: snapshot.activeHeavy,
      waiting: snapshot.waiting,
      queuedBytes: snapshot.queuedBytes,
      shedTotal: snapshot.shedTotal,
    };
  });

  const usageSinks = await section(async () => {
    const { getUsageDeliveryStats } = await import("@/lib/db/usageSinks");
    const stats = getUsageDeliveryStats();
    let pending = 0;
    let dead = 0;
    for (const entry of Object.values(stats)) {
      pending += entry.pending;
      dead += entry.dead;
    }
    return { pending, dead, sinks: Object.keys(stats).length };
  });

  const logExport = await section(async () => {
    const [{ getEnabledLogExportDestinations }, { countCallLogsAfterRowId }] = await Promise.all([
      import("@/lib/db/logExportDestinations"),
      import("@/lib/usage/callLogExportSource"),
    ]);
    const destinations = getEnabledLogExportDestinations().map((destination) => ({
      id: destination.id,
      name: destination.name,
      type: destination.type,
      pending: countCallLogsAfterRowId(destination.cursorRowId),
    }));
    return { pending: destinations.reduce((sum, d) => sum + d.pending, 0), destinations };
  });

  return {
    generatedAt: now.toISOString(),
    draining: { ...getManualDrainState(), shuttingDown: isDraining() },
    inFlight: { requests: getActiveRequestCount() },
    chatAdmission,
    usageSinks,
    logExport,
  };
}
