/** Keep the tray supervised when its native helper dies, and clean up even during startup. */
export async function runTrayLifecycle({
  initialize,
  destroy,
  release,
  onReady,
  healthCheck,
  healthIntervalMs = 10_000,
  signalSource = process,
  timeoutMs = 45_000,
}) {
  let finish;
  let child;
  let timer;
  let healthTimer;
  const controller = new AbortController();
  const shutdown = Symbol("shutdown");
  const stopped = new Promise((resolve) => {
    finish = resolve;
  });
  const stop = () => finish(shutdown);
  const exited = () => finish(new Error("RedRouter native tray helper exited unexpectedly"));
  signalSource.once("SIGINT", stop);
  signalSource.once("SIGTERM", stop);
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("RedRouter tray startup timed out")), timeoutMs);
    });
    const tray = await Promise.race([initialize(), stopped, timeout]);
    clearTimeout(timer);
    if (tray === shutdown) return;
    if (!tray) {
      throw new Error("RedRouter tray is unavailable in this graphical session");
    }
    child = tray._process ?? tray.process;
    child?.once("exit", exited);
    child?.once("error", exited);
    if (child && child.exitCode !== null && child.exitCode !== undefined) exited();
    if (onReady) {
      const result = await Promise.race([
        onReady(tray, controller.signal).then(() => undefined),
        stopped,
      ]);
      if (result === shutdown) return;
      if (result instanceof Error) throw result;
    }
    if (healthCheck) {
      healthTimer = setInterval(() => {
        try {
          if (healthCheck(tray)) return;
        } catch {
          // Loss of the watcher is also unhealthy: let the supervisor retry registration.
        }
        finish(new Error("RedRouter tray lost its desktop registration"));
      }, healthIntervalMs);
    }
    const error = await stopped;
    if (error instanceof Error) throw error;
  } finally {
    controller.abort();
    clearTimeout(timer);
    clearInterval(healthTimer);
    signalSource.removeListener("SIGINT", stop);
    signalSource.removeListener("SIGTERM", stop);
    child?.removeListener("exit", exited);
    child?.removeListener("error", exited);
    try {
      destroy();
    } finally {
      release();
    }
  }
}
