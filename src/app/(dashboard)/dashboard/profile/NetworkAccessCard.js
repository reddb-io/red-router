"use client";

import { useEffect, useState } from "react";
import { Card, Button, SegmentedControl, Icon } from "@/shared/components";
import { ConfirmModal } from "@/shared/components/Modal";

const MODES = [
  { value: "local", label: "This machine only", icon: "computer" },
  { value: "network", label: "Whole network", icon: "lan" },
];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const POLL_MS = 1000;
const POLL_LIMIT = 45;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchStatus() {
  const res = await fetch("/api/settings/network", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function SourceNote({ status }) {
  if (status.source === "flag") {
    return <>This run was started with <code>--host</code>, which wins over the saved choice. The saved choice applies the next time RedRouter starts without it.</>;
  }
  if (status.source === "env") {
    return <>Not started by the <code>red-router</code> CLI: the address comes from the <code>HOSTNAME</code> environment variable. Change it there and restart.</>;
  }
  return null;
}

// Profile → Network access: bind 127.0.0.1 or 0.0.0.0. The choice is saved in the
// data dir and applied by the CLI launcher, which restarts the server on request.
export default function NetworkAccessCard() {
  const [status, setStatus] = useState(null);
  const [mode, setMode] = useState("local");
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });
  const onLoopback = typeof window !== "undefined" && LOOPBACK.has(window.location.hostname);

  useEffect(() => {
    fetchStatus()
      .then((s) => {
        setStatus(s);
        setMode(s.mode || (s.exposed ? "network" : "local"));
      })
      .catch(() => setMessage({ type: "error", text: "Could not read the network setting." }));
  }, []);

  const current = status ? (status.exposed ? "network" : "local") : null;
  const changed = status && (mode !== (status.mode || current) || status.pending);

  async function waitForRestart() {
    await sleep(1500);
    for (let i = 0; i < POLL_LIMIT; i++) {
      try {
        const next = await fetchStatus();
        setStatus(next);
        return next;
      } catch {
        await sleep(POLL_MS);
      }
    }
    return null;
  }

  async function save() {
    setConfirmOpen(false);
    setSaving(true);
    setMessage({ type: "", text: "" });
    try {
      const res = await fetch("/api/settings/network", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, restart: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus(data);
      if (!data.restarting) {
        setMessage({
          type: data.pending ? "info" : "success",
          text: data.pending ? "Saved. It applies the next time RedRouter starts." : "Saved.",
        });
        return;
      }
      if (mode === "local" && !onLoopback) {
        setMessage({ type: "info", text: "Saved. RedRouter is restarting on 127.0.0.1 — open the dashboard on this machine from now on." });
        return;
      }
      setMessage({ type: "info", text: "Restarting RedRouter…" });
      const next = await waitForRestart();
      setMessage(next
        ? { type: "success", text: `RedRouter restarted on ${next.host}:${next.port}.` }
        : { type: "error", text: "RedRouter did not come back yet. Check the terminal or service running it." });
    } catch (error) {
      setMessage({ type: "error", text: `Could not save: ${error.message}` });
    } finally {
      setSaving(false);
    }
  }

  function onSave() {
    // Choosing local from another device cuts that device off.
    if (mode === "local" && !onLoopback && status?.canRestart) setConfirmOpen(true);
    else save();
  }

  const messageClass = {
    error: "text-feedback-danger-foreground",
    success: "text-feedback-success-foreground",
    info: "text-text-muted",
  }[message.type] || "text-text-muted";

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="size-10 rounded-lg bg-feedback-info-surface text-feedback-info-foreground flex items-center justify-center shrink-0">
          <Icon name="lan" size={20} />
        </div>
        <div className="min-w-0">
          <h3 className="text-base sm:text-lg font-semibold">Network access</h3>
          <p className="text-xs sm:text-sm text-text-muted">Who can reach the dashboard and the API.</p>
        </div>
      </div>

      {!status ? (
        <p className={`text-sm ${messageClass}`}>{message.text || "Loading…"}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="p-3 rounded-lg bg-bg border border-border text-sm flex flex-col gap-1">
            <p>
              Now bound to <code>{status.host}:{status.port}</code> —{" "}
              {status.exposed ? "reachable from other devices" : "this machine only"}.
            </p>
            {status.urls.length > 0 && (
              <p className="text-text-muted break-all">
                From other devices: {status.urls.map((u, i) => (
                  <span key={u}>{i > 0 && ", "}<code>{u}</code></span>
                ))}
              </p>
            )}
            {status.pinned && <p className="text-text-muted"><SourceNote status={status} /></p>}
          </div>

          <SegmentedControl options={MODES} value={mode} onChange={setMode} size="sm" />

          <p className="text-xs sm:text-sm text-text-muted">
            {mode === "local"
              ? "Binds 127.0.0.1: only programs on this machine can connect."
              : "Binds 0.0.0.0: any device that can reach this machine can open the dashboard and call the API. Keep login on and give clients API keys."}
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={onSave} loading={saving} disabled={!changed || saving}>
              {status.canRestart ? "Save and restart" : "Save"}
            </Button>
            {message.text && <p className={`text-xs sm:text-sm ${messageClass}`}>{message.text}</p>}
          </div>
          <p className="text-xs text-text-muted">
            Also from a terminal: <code>red-router network local</code> or <code>red-router network lan</code>.
          </p>
        </div>
      )}

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={save}
        title="Switch to this machine only?"
        message={`You're using the dashboard from another device (${typeof window !== "undefined" ? window.location.host : ""}). After the restart it will only answer on the machine running RedRouter.`}
        confirmText="Switch and restart"
        variant="danger"
      />
    </Card>
  );
}
