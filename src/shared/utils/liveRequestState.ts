import type { WsEventPayload, LiveRequest } from "@/hooks/useLiveDashboard";

// This is a bounded UI projection, not the source of truth for running calls.
// Allow long reasoning calls, but expire starts whose terminal event was lost.
export const MAX_ACTIVE_LIVE_REQUESTS = 256;
export const LIVE_REQUEST_TTL_MS = 45 * 60 * 1000;
export const MAX_COMPLETED_LIVE_REQUESTS = 100;

export interface LiveRequestState {
  active: Map<string, LiveRequest>;
  completed: LiveRequest[];
}

export function expireLiveRequests(state: LiveRequestState, now: number): LiveRequestState {
  const stale = [...state.active].filter(
    ([, request]) => now - request.timestamp >= LIVE_REQUEST_TTL_MS
  );
  if (stale.length === 0) return state;
  const active = new Map(state.active);
  for (const [id] of stale) active.delete(id);
  return { ...state, active };
}

export function applyLiveRequestEvent(
  previous: LiveRequestState,
  event: WsEventPayload,
  now = Date.now()
): LiveRequestState {
  if (event.channel !== "requests" || !event.data || typeof event.data !== "object")
    return previous;
  const data = event.data as Record<string, unknown>;
  if (typeof data.id !== "string" || !data.id) return previous;
  const state = expireLiveRequests(previous, now);
  const existing = state.active.get(data.id);
  if (event.event === "request.started") {
    const timestamp =
      typeof data.timestamp === "number" && Number.isFinite(data.timestamp)
        ? Math.min(data.timestamp, now)
        : Math.min(event.timestamp, now);
    if (now - timestamp >= LIVE_REQUEST_TTL_MS) return state;
    // Replayed starts must not resurrect a request already completed in this tab.
    if (state.completed.some((request) => request.id === data.id)) return state;
    const active = new Map(state.active);
    active.set(data.id, {
      id: data.id,
      model: typeof data.model === "string" ? data.model : "",
      provider: typeof data.provider === "string" ? data.provider : "",
      timestamp,
      status: existing?.status || "pending",
      comboName: typeof data.comboName === "string" ? data.comboName : undefined,
    });
    while (active.size > MAX_ACTIVE_LIVE_REQUESTS) active.delete(active.keys().next().value!);
    return { ...state, active };
  }
  if (!existing) return state;
  if (event.event === "request.streaming") {
    if (existing.status === "running") return state;
    const active = new Map(state.active);
    active.set(data.id, { ...existing, status: "running" });
    return { ...state, active };
  }
  if (event.event !== "request.completed" && event.event !== "request.failed") return state;
  const active = new Map(state.active);
  active.delete(data.id);
  const done: LiveRequest = {
    ...existing,
    status: event.event === "request.completed" && data.status === "success" ? "success" : "error",
    tokensInput: typeof data.tokensInput === "number" ? data.tokensInput : undefined,
    tokensOutput: typeof data.tokensOutput === "number" ? data.tokensOutput : undefined,
    latencyMs: typeof data.latencyMs === "number" ? data.latencyMs : undefined,
    error: typeof data.error === "string" ? data.error.slice(0, 2048) : undefined,
  };
  return { active, completed: [done, ...state.completed].slice(0, MAX_COMPLETED_LIVE_REQUESTS) };
}
