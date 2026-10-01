"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card } from "@/shared/components";

type NetworkStatus = {
  host: string;
  port: number;
  mode: "local" | "lan" | "custom";
  configuredHost: string;
  managed: boolean;
  canApply: boolean;
  pendingRestart: boolean;
  restartError: string | null;
  addresses: { address: string; dashboardUrl: string; apiBaseUrl: string; healthUrl: string }[];
};
const endpoint = "/api/settings/network";

async function networkRequest(signal: AbortSignal, init: RequestInit = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    return await fetch(endpoint, { cache: "no-store", ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function readStatus(signal: AbortSignal): Promise<NetworkStatus> {
  const response = await networkRequest(signal);
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "Sign in to manage network access."
        : "Unable to load network access settings."
    );
  return response.json();
}

export default function NetworkAccessCard() {
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [mode, setMode] = useState<NetworkStatus["mode"]>("local");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    setLoading(true);
    setError("");
    readStatus(active.signal)
      .then((data) => {
        if (active.signal.aborted) return;
        setStatus(data);
        setMode(
          data.pendingRestart ? (data.configuredHost === "0.0.0.0" ? "lan" : "local") : data.mode
        );
        setError(data.restartError || "");
      })
      .catch((failure: Error) => {
        if (!active.signal.aborted) setError(failure.message);
      })
      .finally(() => {
        if (!active.signal.aborted) setLoading(false);
      });
    return () => active.abort();
  }, [attempt]);

  const apply = async () => {
    if (mode === "custom" || !status?.canApply || !controller.current) return;
    const signal = controller.current.signal;
    setBusy(true);
    setError("");
    setMessage("Applying network access and restarting RedRouter…");
    try {
      let response: Response | undefined;
      try {
        response = await networkRequest(
          signal,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode }),
          },
          20000
        );
      } catch {
        // The response can be lost during a restart. Verify the effective listener
        // before reporting either success or failure.
        if (signal.aborted) return;
      }
      if (response && !response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message || "Unable to apply network access.");
      }
      const deadline = Date.now() + 120000;
      while (!signal.aborted && Date.now() < deadline) {
        let data: NetworkStatus | undefined;
        try {
          data = await readStatus(signal);
        } catch {
          /* Restart closes existing connections. */
        }
        if (data?.restartError) throw new Error(data.restartError);
        if (data && !signal.aborted) {
          setStatus(data);
          if (data.mode === mode && !data.pendingRestart) {
            setMessage(
              mode === "lan"
                ? "Local network access is enabled."
                : "RedRouter is now accessible only on this computer."
            );
            return;
          }
        }
        await new Promise<void>((accept) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            accept();
          };
          const timer = setTimeout(done, 2000);
          signal.addEventListener("abort", done, { once: true });
        });
      }
      if (!signal.aborted)
        throw new Error("Restart is not confirmed. Reload the status before retrying.");
    } catch (failure) {
      if (!signal.aborted) {
        setError((failure as Error).message);
        setMessage("");
      }
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setMessage("API address copied.");
    } catch {
      setError("Unable to copy. Select and copy the API address below.");
    }
  };

  return (
    <Card
      title="Network access"
      subtitle="Connect other computers and RedRouter instances to this router."
    >
      {loading ? (
        <div
          className="h-24 animate-pulse rounded bg-bg-secondary"
          aria-label="Loading network access"
        />
      ) : (
        <>
          <label htmlFor="network-access-mode" className="block text-sm font-medium mb-2">
            Allow connections from
          </label>
          <select
            id="network-access-mode"
            value={mode}
            disabled={!status?.canApply || busy}
            onChange={(event) => {
              setMode(event.target.value as NetworkStatus["mode"]);
              setError("");
              setMessage("");
            }}
            className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm"
          >
            <option value="local">Only this computer</option>
            <option value="lan">Local network (all IPv4 interfaces)</option>
            {status?.mode === "custom" && (
              <option value="custom">Current custom address: {status.host}</option>
            )}
          </select>
          {status && (
            <p className="mt-2 text-xs text-text-muted">
              Listening on{" "}
              <code>
                {status.host}:{status.port}
              </code>
              .{status.pendingRestart && " Saved configuration is waiting for a restart."}
            </p>
          )}
          {mode === "lan" && (
            <p className="mt-2 text-sm text-text-muted">
              Listens on all IPv4 interfaces (0.0.0.0). Use an API key from Access → Keys when
              connecting another RedRouter.
            </p>
          )}
          {status && !status.canApply && (
            <p className="mt-3 text-sm text-text-muted">
              {status.managed
                ? `Open http://localhost:${status.port}/dashboard/settings/security on this computer to change network access.`
                : "Automatic changes require the managed Linux service. For a CLI install, use red-router service install --expose. For Docker or another launcher, configure its bind address and published port."}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              onClick={() => void apply()}
              loading={busy}
              disabled={
                !status?.canApply ||
                mode === "custom" ||
                (mode === status.mode && !status.pendingRestart)
              }
            >
              Apply and restart
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setMessage("");
                setAttempt((value) => value + 1);
              }}
              disabled={busy}
            >
              Reload status
            </Button>
          </div>
          {status && mode === "lan" && (
            <div className="mt-5 border-t border-border pt-4">
              <p className="text-sm font-medium">Use from another computer</p>
              {status.mode !== "lan" && (
                <p className="mt-1 text-xs text-text-muted">
                  These addresses become available after applying local network access.
                </p>
              )}
              {status.addresses.length ? (
                status.addresses.map((address) => (
                  <div key={address.address} className="mt-3 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="break-all text-xs select-all">{address.apiBaseUrl}</code>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void copy(address.apiBaseUrl)}
                      >
                        Copy API address
                      </Button>
                    </div>
                    <a href={address.dashboardUrl} className="block break-all text-xs text-primary">
                      Dashboard: {address.dashboardUrl}
                    </a>
                    <p className="text-xs text-text-muted">
                      Check from the other computer:{" "}
                      <code className="select-all break-all">curl {address.healthUrl}</code>
                    </p>
                  </div>
                ))
              ) : (
                <p className="mt-2 text-sm text-text-muted">
                  No local network address detected. Check this computer's Wi-Fi or Ethernet
                  connection.
                </p>
              )}
              <p className="mt-3 text-xs text-text-muted">
                If access is still blocked, check the firewall and Wi-Fi client isolation. Enabling
                this setting does not change either.
              </p>
            </div>
          )}
        </>
      )}
      {message && (
        <p role="status" className="mt-3 text-sm text-text-muted">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-error">
          {error}
        </p>
      )}
    </Card>
  );
}
