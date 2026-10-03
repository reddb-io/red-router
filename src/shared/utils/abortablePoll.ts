/** One pending poll, with bounded lifetime and cancellation on view cleanup. */
export function createAbortablePoll(timeoutMs = 30_000) {
  let active: AbortController | null = null;
  return {
    async run(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
      if (active) return;
      const controller = new AbortController();
      active = controller;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        await task(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        clearTimeout(timer);
        if (active === controller) active = null;
      }
    },
    cancel() {
      const controller = active;
      active = null;
      controller?.abort();
    },
  };
}
