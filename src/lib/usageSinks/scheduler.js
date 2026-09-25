// Runs the usage sinks engine in the background: a tick every few seconds, and
// an early one shortly after usage is recorded (the stats "update" event) so
// instant sinks deliver without waiting for the interval.
import { statsEmitter } from "@/lib/db/repos/usageRepo.js";
import { runUsageSinksTick } from "./engine.js";

const TICK_MS = 5000;
const NUDGE_DELAY_MS = 500;

if (!global._usageSinksScheduler) global._usageSinksScheduler = { interval: null, nudge: null, state: { running: false } };
const g = global._usageSinksScheduler;

function tick() {
  runUsageSinksTick(undefined, g.state).catch(() => {});
}

function onUsageRecorded() {
  if (g.nudge) return;
  g.nudge = setTimeout(() => { g.nudge = null; tick(); }, NUDGE_DELAY_MS);
  g.nudge.unref?.();
}

export function startUsageSinks() {
  if (g.interval) return;
  g.interval = setInterval(tick, TICK_MS);
  g.interval.unref?.();
  statsEmitter.on("update", onUsageRecorded);
}

export function stopUsageSinks() {
  if (g.interval) clearInterval(g.interval);
  g.interval = null;
  statsEmitter.off("update", onUsageRecorded);
}
