import { afterEach, expect, it, vi } from "vitest";
import { createAbortablePoll } from "@/shared/utils/abortablePoll";

afterEach(() => vi.useRealTimers());

it("slow polls cannot overlap, and a cancelled view can start a fresh request", async () => {
  const poll = createAbortablePoll();
  let release!: () => void;
  let oldSignal!: AbortSignal;
  const first = poll.run(async (signal) => {
    oldSignal = signal;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const next = vi.fn(async () => {});
  await poll.run(next);
  expect(next).not.toHaveBeenCalled();
  poll.cancel();
  expect(oldSignal.aborted).toBe(true);
  await poll.run(next);
  expect(next).toHaveBeenCalledOnce();
  release();
  await first;
});

it("an unresponsive fetch is aborted at the deadline and remains retryable", async () => {
  vi.useFakeTimers();
  const poll = createAbortablePoll(1000);
  const first = poll.run(async (signal) => {
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason))
    );
  });
  await vi.advanceTimersByTimeAsync(1000);
  await first;
  const retry = vi.fn(async () => {});
  await poll.run(retry);
  expect(retry).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
