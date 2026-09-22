"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card } from "@/shared/components";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useRuntimeVersion } from "@/shared/hooks/useRuntimeVersion";

export default function UpdateSection() {
  const runtimeVersion = useRuntimeVersion();
  const { copied, copy } = useCopyToClipboard(5000);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [shuttingDown, setShuttingDown] = useState(false);

  const checkForUpdates = useCallback(async () => {
    setChecking(true);
    setError("");

    try {
      const response = await fetch("/api/version", { cache: "no-store" });
      if (!response.ok) throw new Error("Version check failed");
      setUpdateInfo(await response.json());
    } catch {
      setError("Could not check for updates.");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    checkForUpdates();
  }, [checkForUpdates]);

  const shutdownForUpdate = async () => {
    setShuttingDown(true);
    try {
      await fetch("/api/version/shutdown", { method: "POST" });
    } catch {
      // The request commonly disconnects because the server exits immediately.
    }
  };

  const hasUpdate = updateInfo?.hasUpdate === true;

  return (
    <Card>
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-text-main">Software update</h3>
            <p className="mt-1 text-sm text-text-muted">
              Installed version <span className="font-mono text-text-main">v{runtimeVersion}</span>
            </p>
          </div>
          {!hasUpdate && !checking && !error && (
            <span className="inline-flex min-h-7 items-center rounded-full bg-green-500/10 px-2.5 text-xs font-medium text-green-700 dark:text-green-400">
              Up to date
            </span>
          )}
        </div>

        {checking && <p className="text-sm text-text-muted">Checking for updates…</p>}

        {error && (
          <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            <Button variant="outline" size="sm" onClick={checkForUpdates}>Retry</Button>
          </div>
        )}

        {hasUpdate && (
          <div className="border-t border-border pt-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-text-main">Version v{updateInfo.latestVersion} is available</p>
                <p className="mt-1 text-xs text-text-muted">Review the command before stopping this instance.</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setExpanded((value) => !value)}>
                {expanded ? "Hide instructions" : "Review update"}
              </Button>
            </div>

            {expanded && (
              <div className="mt-4 border-t border-border pt-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-text-muted">Install command</p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-bg px-3 py-2.5 font-mono text-xs text-text-main">
                    {UPDATER_CONFIG.installCmdLatest}
                  </code>
                  <Button variant="secondary" size="sm" onClick={() => copy(UPDATER_CONFIG.installCmdLatest)}>
                    {copied ? "Copied" : "Copy command"}
                  </Button>
                </div>
                <p className="mt-3 text-xs text-text-muted">
                  Copy the command, stop RedRouter, run it in your terminal, then start RedRouter again.
                </p>
                <div className="mt-4 flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    icon="power_settings_new"
                    onClick={shutdownForUpdate}
                    disabled={!copied || shuttingDown}
                    loading={shuttingDown}
                    className="text-red-600 dark:text-red-400"
                  >
                    Shut down for update
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {!hasUpdate && !checking && !error && (
          <div className="flex justify-end border-t border-border pt-4">
            <Button variant="ghost" size="sm" onClick={checkForUpdates}>Check again</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
