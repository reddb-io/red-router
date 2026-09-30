"use client";

import { CircleAlert, CircleCheck, Info, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import Icon from "@/shared/components/Icon";
import { Badge, Button, Card, ConfirmModal, Input, Modal, Textarea } from "@/shared/components";

/** Shapes returned by GET /api/settings/wireguard-egress and .../binary. No key material. */
type EgressPhase = "stopped" | "starting" | "running" | "error";

type EgressProfile = {
  id: string;
  name: string;
  enabled: boolean;
  endpointHost: string;
  endpointPort: number;
  addresses: string[];
  socksPort: number;
  proxyId: string | null;
  hasPrivateKey: boolean;
  hasPresharedKey: boolean;
  status: {
    phase: EgressPhase;
    lastError: string | null;
    restarts: number;
    retryInMs: number | null;
  };
  proxy: { id: string; status: string } | null;
};

type BinaryStatus = {
  installed: boolean;
  source: "env" | "managed" | "path" | null;
  supported: boolean;
  installable: boolean;
  version: string;
  platform: string;
  message: string | null;
};

type IgnoredLine = { line: number; key: string; reason: string };

type NoticeTone = "success" | "info" | "warning" | "danger";
type Notice = { tone: NoticeTone; message: ReactNode };

const NOTICE_CLASS: Record<NoticeTone, string> = {
  success:
    "border-feedback-success-border bg-feedback-success-surface text-feedback-success-foreground",
  info: "border-feedback-info-border bg-feedback-info-surface text-feedback-info-foreground",
  warning:
    "border-feedback-warning-border bg-feedback-warning-surface text-feedback-warning-foreground",
  danger:
    "border-feedback-danger-border bg-feedback-danger-surface text-feedback-danger-foreground",
};

const NOTICE_ICON = {
  success: CircleCheck,
  info: Info,
  warning: TriangleAlert,
  danger: CircleAlert,
} as const;

const PHASE_PILL: Record<
  EgressPhase,
  { label: string; tone: "success" | "info" | "default" | "danger" }
> = {
  running: { label: "Running", tone: "success" },
  starting: { label: "Starting", tone: "info" },
  stopped: { label: "Stopped", tone: "default" },
  error: { label: "Error", tone: "danger" },
};

const SOURCE_TEXT = {
  env: "WIREPROXY_BIN",
  managed: "installed by RedRouter",
  path: "found on PATH",
};

const POLL_MS = 10_000;

function InlineNotice({ notice, onDismiss }: { notice: Notice; onDismiss?: () => void }) {
  return (
    <div
      role={notice.tone === "danger" || notice.tone === "warning" ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${NOTICE_CLASS[notice.tone]}`}
    >
      <Icon icon={NOTICE_ICON[notice.tone]} size="md" color="current" className="mt-0.5" />
      <span className="min-w-0 flex-1 break-words">{notice.message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rounded p-0.5 transition-colors hover:bg-surface/40"
        >
          <Icon icon={X} size="sm" color="current" />
        </button>
      )}
    </div>
  );
}

function errorText(data: unknown): string | null {
  const error = (data as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message : null;
}

async function callApi(
  url: string,
  method: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

const BASE = "/api/settings/wireguard-egress";

/**
 * WireGuard (VPN egress): run a WireGuard client in user space (wireproxy, no root) and expose it as
 * a local SOCKS5 proxy in the proxy registry, so provider traffic can leave through a VPN.
 */
export default function WireGuardEgressCard() {
  const [profiles, setProfiles] = useState<EgressProfile[]>([]);
  const [binary, setBinary] = useState<BinaryStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [config, setConfig] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<EgressProfile | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    const [list, bin] = await Promise.all([callApi(BASE, "GET"), callApi(`${BASE}/binary`, "GET")]);
    if (list.status === 403 || bin.status === 403) {
      // Tunnel management is loopback-only; a remote dashboard cannot use it.
      setUnavailable(true);
    } else {
      setUnavailable(false);
      if (list.ok && Array.isArray(list.data?.items)) {
        setProfiles(list.data.items as EgressProfile[]);
      }
      if (bin.ok && bin.data) setBinary(bin.data as unknown as BinaryStatus);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  const openAdd = () => {
    setName("");
    setConfig("");
    setFormError(null);
    setAddOpen(true);
  };

  const create = async () => {
    setFormError(null);
    if (!name.trim()) {
      setFormError("Give the profile a name.");
      return;
    }
    if (!config.trim()) {
      setFormError("Paste the WireGuard configuration file.");
      return;
    }
    setSaving(true);
    const { ok, data } = await callApi(BASE, "POST", { name, config });
    setSaving(false);
    // The pasted config holds the private key: drop it from the page whatever the outcome.
    setConfig("");
    if (!ok) {
      setFormError(errorText(data) ?? "Could not save the profile.");
      return;
    }
    setAddOpen(false);
    const ignored = (data?.ignored as IgnoredLine[] | undefined) ?? [];
    setNotice({
      tone: ignored.length > 0 ? "warning" : "success",
      message:
        ignored.length > 0
          ? `Profile saved, stopped. ${ignored.length} line(s) were ignored and never run: ${ignored
              .map((entry) => `${entry.key} (line ${entry.line})`)
              .join(", ")}. Enable it to start the tunnel.`
          : "Profile saved, stopped. Enable it to start the tunnel.",
    });
    await refresh();
  };

  const act = async (profile: EgressProfile, action: "enable" | "disable" | "restart") => {
    setBusyId(profile.id);
    setNotice(null);
    const { ok, data } = await callApi(`${BASE}/${profile.id}`, "PATCH", { action });
    if (!ok) {
      setNotice({
        tone: "danger",
        message: errorText(data) ?? "The request failed.",
      });
    } else if (action === "enable") {
      setNotice({
        tone: "info",
        message: (
          <>
            Tunnel running. Assign the proxy <strong>WireGuard: {profile.name}</strong> to
            connections, providers or combos in the proxy registry above to send their traffic
            through it.
          </>
        ),
      });
    }
    await refresh();
    setBusyId(null);
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const { ok, data } = await callApi(`${BASE}/${deleteTarget.id}`, "DELETE");
    setDeleting(false);
    setDeleteTarget(null);
    setNotice(
      ok
        ? { tone: "info", message: "Profile deleted." }
        : { tone: "danger", message: errorText(data) ?? "Could not delete the profile." }
    );
    await refresh();
  };

  const install = async () => {
    setInstalling(true);
    setNotice(null);
    const { ok, data } = await callApi(`${BASE}/install-binary`, "POST");
    setInstalling(false);
    setNotice(
      ok
        ? { tone: "success", message: "wireproxy installed and verified." }
        : { tone: "danger", message: errorText(data) ?? "Could not install wireproxy." }
    );
    await refresh();
  };

  return (
    <Card padding="md">
      <div className="flex items-start gap-3">
        <Icon icon={ShieldCheck} size="md" color="current" className="mt-1" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">WireGuard (VPN egress)</h3>
            {binary?.installed && (
              <Badge variant="success" size="sm">
                wireproxy {binary.source ? SOURCE_TEXT[binary.source] : "found"}
              </Badge>
            )}
            {binary && !binary.installed && (
              <Badge variant="warning" size="sm">
                wireproxy not installed
              </Badge>
            )}
          </div>
          <p className="text-xs text-ink-muted">
            Send provider traffic through a WireGuard VPN (Mullvad, Proton, Cloudflare WARP or your
            own server). Runs in user space with no root and shows up as a local SOCKS5 proxy in the
            registry.
          </p>
        </div>
        {!unavailable && (
          <div className="flex shrink-0 items-center gap-2">
            {binary && !binary.installed && (
              <Button
                size="sm"
                variant="secondary"
                loading={installing}
                disabled={!binary.installable || !binary.supported}
                onClick={() => void install()}
              >
                Install wireproxy
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={openAdd}>
              Add profile
            </Button>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {unavailable && (
          <InlineNotice
            notice={{
              tone: "info",
              message: "Manage WireGuard egress from the machine running RedRouter.",
            }}
          />
        )}
        {binary && !binary.installed && binary.message && (
          <InlineNotice notice={{ tone: "warning", message: binary.message }} />
        )}
        <InlineNotice
          notice={{
            tone: "info",
            message:
              "Fail closed: if a tunnel is stopped or down, connections assigned to its proxy are refused instead of leaving directly. Assign the proxy from the registry above.",
          }}
        />
        {notice && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}
      </div>

      {loaded && !unavailable && profiles.length === 0 && (
        <p className="mt-4 text-sm text-ink-muted">
          No WireGuard profiles yet. Add one by pasting the .conf file your VPN provider gives you.
        </p>
      )}

      {profiles.length > 0 && (
        <ul className="mt-4 divide-y divide-border/30 border-t border-border/30">
          {profiles.map((profile) => {
            const pill = PHASE_PILL[profile.status.phase];
            const busy = busyId === profile.id;
            const running = profile.status.phase === "running";
            const active = profile.enabled || running || profile.status.phase === "starting";
            return (
              <li key={profile.id} className="py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{profile.name}</span>
                      <Badge variant={pill.tone} size="sm">
                        {pill.label}
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-ink-muted">
                      {profile.endpointHost}:{profile.endpointPort} &middot; local SOCKS5 127.0.0.1:
                      {profile.socksPort}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {active && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void act(profile, "restart")}
                      >
                        Restart
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={active ? "secondary" : "primary"}
                      loading={busy}
                      onClick={() => void act(profile, active ? "disable" : "enable")}
                    >
                      {active ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setDeleteTarget(profile)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                {profile.status.lastError && !running && (
                  <p className="mt-1 text-xs text-feedback-danger-foreground">
                    Last error: {profile.status.lastError}
                    {profile.status.retryInMs !== null
                      ? ` Retrying in ${Math.ceil(profile.status.retryInMs / 1000)}s.`
                      : ""}
                  </p>
                )}
                {profile.proxy && (
                  <p className="mt-1 text-xs text-ink-muted">
                    Registry proxy &ldquo;WireGuard: {profile.name}&rdquo; is {profile.proxy.status}
                    {profile.proxy.status === "active"
                      ? "."
                      : "; anything assigned to it is refused until the tunnel is running."}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Modal
        isOpen={addOpen}
        title="Add WireGuard profile"
        onClose={() => {
          if (saving) return;
          setConfig("");
          setAddOpen(false);
        }}
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setConfig("");
                setAddOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void create()}>
              Save profile
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Mullvad Sweden"
            autoComplete="off"
            disabled={saving}
          />
          <div className="flex flex-col gap-1">
            <label htmlFor="wireguard-egress-config" className="text-sm font-medium">
              WireGuard configuration
            </label>
            <Textarea
              id="wireguard-egress-config"
              value={config}
              onChange={(event) => setConfig(event.target.value)}
              rows={12}
              placeholder={
                "[Interface]\nPrivateKey = ...\nAddress = ...\n\n[Peer]\nPublicKey = ...\nEndpoint = ...:51820"
              }
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
              className="font-mono text-xs"
            />
            <p className="text-xs text-ink-muted">
              Paste the .conf from your provider (one [Interface] and exactly one [Peer]). The
              private key is stored encrypted and never shown again. PostUp, PostDown and other
              wg-quick hooks are ignored and never run.
            </p>
          </div>
          {formError && (
            <p role="alert" className="text-sm text-feedback-danger-foreground">
              {formError}
            </p>
          )}
        </div>
      </Modal>

      <ConfirmModal
        isOpen={deleteTarget !== null}
        onClose={() => !deleting && setDeleteTarget(null)}
        onConfirm={() => void remove()}
        title="Delete WireGuard profile"
        message={
          deleteTarget
            ? `Delete "${deleteTarget.name}" and its stored keys? If its proxy is still assigned to connections or providers, unassign it first.`
            : ""
        }
        confirmText="Delete"
        variant="danger"
        loading={deleting}
      />
    </Card>
  );
}
