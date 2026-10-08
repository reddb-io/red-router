import { getServerLifecyclePhase } from "@/lib/serverLifecycle";
import { observeHealthzEventLoopLag } from "@/lib/healthzLag";
import { isManualDrainActive } from "@/lib/system/drainMode";
import { verifyRoutingStorage } from "@/lib/db/repositories/routingConfigRepositories";

export const dynamic = "force-dynamic";

const HEALTH_BODIES = {
  ready: "ok\n",
  starting: "starting\n",
  stopping: "stopping\n",
} as const;

async function createHealthResponse(method: "GET" | "HEAD"): Promise<Response> {
  const phase = getServerLifecyclePhase();
  // An operator drain (POST /api/system/drain) takes the node out of rotation: not ready.
  const draining = phase === "ready" && isManualDrainActive();
  let body: string = draining ? "draining\n" : HEALTH_BODIES[phase];
  let ready = phase === "ready" && !draining;
  if (ready) {
    try {
      await verifyRoutingStorage();
    } catch {
      ready = false;
      body = "storage_unavailable\n";
    }
  }

  return new Response(method === "HEAD" ? null : body, {
    status: ready ? 200 : 503,
    headers: {
      "Cache-Control": "no-store",
      "Content-Length": String(body.length),
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export function GET(): Promise<Response> {
  observeHealthzEventLoopLag();
  return createHealthResponse("GET");
}

export function HEAD(): Promise<Response> {
  return createHealthResponse("HEAD");
}
