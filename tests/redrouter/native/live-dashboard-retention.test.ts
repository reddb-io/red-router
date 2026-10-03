import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyLiveRequestEvent,
  expireLiveRequests,
  LIVE_REQUEST_TTL_MS,
  MAX_ACTIVE_LIVE_REQUESTS,
  MAX_COMPLETED_LIVE_REQUESTS,
  type LiveRequestState,
} from "../../../src/shared/utils/liveRequestState.ts";

const start = (id: string, now: number) => ({
  channel: "requests" as const,
  event: "request.started",
  timestamp: now,
  data: { id, model: "gpt-6.1-sol", provider: "codex", timestamp: now },
});
const empty = (): LiveRequestState => ({ active: new Map(), completed: [] });

test("lost terminal events have bounded retention, including when traffic stops", () => {
  let state = empty();
  for (let i = 0; i < 10_000; i++) state = applyLiveRequestEvent(state, start(String(i), i), i);
  assert.equal(state.active.size, MAX_ACTIVE_LIVE_REQUESTS);
  assert.equal(state.active.has("0"), false);
  const expired = expireLiveRequests(state, LIVE_REQUEST_TTL_MS + 10_000);
  assert.equal(expired.active.size, 0);
  assert.equal(state.active.size, MAX_ACTIVE_LIVE_REQUESTS, "previous state is immutable");
  assert.equal(applyLiveRequestEvent(expired, start("old", 0), LIVE_REQUEST_TTL_MS + 1), expired);
});

test("completed requests stay bounded and replay does not resurrect them", () => {
  let state = empty();
  for (let i = 0; i < 500; i++) {
    state = applyLiveRequestEvent(state, start(String(i), i), i);
    state = applyLiveRequestEvent(
      state,
      {
        ...start(String(i), i),
        event: "request.completed",
        data: { id: String(i), status: "success" },
      },
      i
    );
  }
  assert.equal(state.active.size, 0);
  assert.equal(state.completed.length, MAX_COMPLETED_LIVE_REQUESTS);
  assert.equal(applyLiveRequestEvent(state, start("499", 500), 500), state);
});
