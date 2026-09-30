"use client";

import {
  Cloud,
  CircleAlert,
  CircleCheck,
  Globe,
  Info,
  Lock,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import Icon from "@/shared/components/Icon";
import { Badge, Button, Input, Modal } from "@/shared/components";
import { checkTunnelHostname, normalizeTunnelToken } from "@/shared/validation/namedTunnelSchemas";
import {
  NAMED_TUNNEL_PILLS,
  SERVE_PILLS,
  namedTunnelExposureNotice,
  namedTunnelPrimaryAction,
  servePrimaryAction,
  type NamedTunnelPhase,
  type ServePhase,
} from "./tunnelPresentation";

/** Shapes returned by GET /api/tunnels/cloudflared-named and /api/tunnels/tailscale-serve. */
export type NamedTunnelStatus = {
  supported: boolean;
  installed: boolean;
  configured: boolean;
  hasToken: boolean;
  hostname: string | null;
  running: boolean;
  publicUrl: string | null;
  apiUrl: string | null;
  targetUrl: string;
  phase: NamedTunnelPhase;
  lastError: string | null;
  requireApiKey: boolean;
};

export type TailscaleServeTunnelStatus = {
  supported: boolean;
  installed: boolean;
  loggedIn: boolean;
  daemonRunning: boolean;
  running: boolean;
  publicExposure: boolean;
  tunnelUrl: string | null;
  apiUrl: string | null;
  phase: ServePhase;
  platform: string;
  lastError: string | null;
};

export type NoticeTone = "success" | "info" | "warning" | "danger";
export type Notice = { tone: NoticeTone; message: ReactNode };

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

const POLL_MS = 30_000;

export function InlineNotice({ notice, onDismiss }: { notice: Notice; onDismiss?: () => void }) {
  return (
    <div
      role={notice.tone === "danger" || notice.tone === "warning" ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${NOTICE_CLASS[notice.tone]}`}
    >
      <Icon icon={NOTICE_ICON[notice.tone]} size="md" color="current" className="mt-0.5" />
      <span className="flex-1 min-w-0 break-words">{notice.message}</span>
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

/** Group heading inside the Tunnels card ("Private" / "Public") with its one-line explanation. */
export function TunnelGroupHeader({
  kind,
  description,
}: {
  kind: "private" | "public";
  description: string;
}) {
  return (
    <div className="flex items-start gap-2 pt-4 pb-1">
      <Icon
        icon={kind === "private" ? Lock : Globe}
        size="sm"
        color="ink-muted"
        className="mt-0.5"
      />
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {kind === "private" ? "Private" : "Public"}
        </p>
        <p className="text-xs text-ink-muted">{description}</p>
      </div>
    </div>
  );
}

export function errorText(data: unknown): string | null {
  const error = (data as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message : null;
}

export async function callTunnelApi(
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

export function useTunnelStatus<T>(url: string, onStatusChange?: (status: T | null) => void) {
  const [status, setStatus] = useState<T | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const onChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  const apply = useCallback((next: T | null) => {
    setStatus(next);
    onChangeRef.current?.(next);
  }, []);

  const refresh = useCallback(async () => {
    const { ok, status: code, data } = await callTunnelApi(url, "GET");
    if (ok && data) {
      setUnavailable(false);
      apply(data as T);
    } else if (code === 403) {
      // Tunnel management is loopback-only; a remote dashboard cannot read it.
      setUnavailable(true);
      apply(null);
    }
  }, [url, apply]);

  useEffect(() => {
    // Initial load on the next tick, then poll; state is only set from the request callbacks.
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  return { status, unavailable, refresh, apply };
}

/** `endpoint.*` message with an inline English fallback, like the rest of the Endpoint page. */
export function useEndpointText() {
  const t = useTranslations("endpoint");
  return useCallback(
    (key: string, fallback: string) => {
      try {
        const message = t(key as never);
        return !message || message === key || message === `endpoint.${key}` ? fallback : message;
      } catch {
        return fallback;
      }
    },
    [t]
  );
}

export const UNAVAILABLE_TEXT = "Manage this tunnel from the machine running RedRouter.";

/** Cloudflare Named Tunnel row: a stable public URL on the operator's own domain. */
export function CloudflaredNamedTunnelRow({
  onStatusChange,
  bordered = true,
}: {
  onStatusChange?: (status: NamedTunnelStatus | null) => void;
  /** Draw the divider above the row; off for the first row under a group heading. */
  bordered?: boolean;
}) {
  const tr = useEndpointText();
  const { status, unavailable, refresh, apply } = useTunnelStatus<NamedTunnelStatus>(
    "/api/tunnels/cloudflared-named",
    onStatusChange
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [token, setToken] = useState("");
  const [hostname, setHostname] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [hostnameError, setHostnameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const phase: NamedTunnelPhase = status?.phase ?? "not_configured";
  const pill = NAMED_TUNNEL_PILLS[phase];
  const action = namedTunnelPrimaryAction(status);
  const exposed = phase === "running" || phase === "starting";
  const exposure = namedTunnelExposureNotice(status?.requireApiKey ?? true);

  const openModal = () => {
    setToken("");
    setHostname(status?.hostname ?? "");
    setTokenError(null);
    setHostnameError(null);
    setModalOpen(true);
  };

  const post = async (nextAction: "enable" | "disable" | "restart") => {
    setBusy(true);
    setNotice(null);
    const { ok, data } = await callTunnelApi("/api/tunnels/cloudflared-named", "POST", {
      action: nextAction,
    });
    if (ok && data?.status) {
      apply(data.status as NamedTunnelStatus);
      setNotice({
        tone: "success",
        message:
          nextAction === "disable"
            ? tr("namedTunnelStopped", "Cloudflare Named Tunnel stopped")
            : tr("namedTunnelStarted", "Cloudflare Named Tunnel connected"),
      });
    } else {
      setNotice({
        tone: "danger",
        message:
          errorText(data) ?? tr("namedTunnelRequestFailed", "Failed to update the named tunnel"),
      });
      await refresh();
    }
    setBusy(false);
  };

  const save = async (enableAfter: boolean) => {
    const host = checkTunnelHostname(hostname);
    const trimmed = token.trim();
    const needsToken = !status?.hasToken;
    let bad = false;
    setHostnameError(host.ok ? null : host.reason);
    if (!host.ok) bad = true;
    if (trimmed || needsToken) {
      const normalized = normalizeTunnelToken(trimmed);
      if (normalized.length < 20) {
        setTokenError(tr("namedTunnelTokenInvalid", "Enter the tunnel token from Cloudflare"));
        bad = true;
      } else {
        setTokenError(null);
      }
    } else {
      setTokenError(null);
    }
    if (bad || !host.ok) return;

    setSaving(true);
    const { ok, data } = await callTunnelApi("/api/tunnels/cloudflared-named/config", "PUT", {
      hostname: host.hostname,
      ...(trimmed ? { token: trimmed } : {}),
    });
    setSaving(false);
    if (!ok) {
      setHostnameError(errorText(data) ?? tr("namedTunnelSaveFailed", "Could not save the settings"));
      return;
    }
    setToken("");
    setModalOpen(false);
    if (data?.status) apply(data.status as NamedTunnelStatus);
    if (enableAfter) await post(status?.running ? "restart" : "enable");
  };

  const remove = async () => {
    setSaving(true);
    const { ok, data } = await callTunnelApi("/api/tunnels/cloudflared-named/config", "DELETE");
    setSaving(false);
    if (ok) {
      setModalOpen(false);
      if (data?.status) apply(data.status as NamedTunnelStatus);
      setNotice({
        tone: "info",
        message: tr("namedTunnelRemoved", "Named tunnel settings removed"),
      });
    } else {
      setHostnameError(errorText(data) ?? tr("namedTunnelSaveFailed", "Could not remove the settings"));
    }
  };

  const primaryLabel =
    action === "set-up"
      ? tr("namedTunnelSetUp", "Set up")
      : action === "stop"
        ? tr("namedTunnelStop", "Stop Tunnel")
        : status?.installed
          ? tr("namedTunnelEnable", "Enable Tunnel")
          : tr("namedTunnelInstallAndEnable", "Install & Enable");

  return (
    <div className={bordered ? "border-t border-border/30" : undefined}>
      <div className="flex items-center gap-3 py-3">
        <Icon icon={Cloud} size="md" color="current" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {tr("namedTunnelTitle", "Cloudflare Named Tunnel")}
            </span>
            <Badge variant="warning" size="sm">
              {tr("tunnelBadgePublic", "Public")}
            </Badge>
          </div>
          <p className="truncate text-xs text-ink-muted">
            {status?.hostname
              ? `https://${status.hostname}`
              : tr("namedTunnelSubtitle", "Stable URL on your own domain")}
          </p>
        </div>
        <Badge variant={pill.tone}>{pill.label}</Badge>
        {status?.supported !== false && !unavailable && (
          <div className="flex shrink-0 items-center gap-2">
            {action === "stop" && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void post("restart")}
              >
                {tr("namedTunnelRestart", "Restart")}
              </Button>
            )}
            {action !== "set-up" && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={openModal}>
                {tr("namedTunnelEdit", "Edit")}
              </Button>
            )}
            <Button
              size="sm"
              variant={action === "stop" ? "secondary" : "primary"}
              loading={busy}
              onClick={() => {
                if (action === "set-up") openModal();
                else void post(action === "stop" ? "disable" : "enable");
              }}
            >
              {primaryLabel}
            </Button>
          </div>
        )}
      </div>

      <div className="mb-3 ml-7 flex flex-col gap-2">
        {unavailable && <InlineNotice notice={{ tone: "info", message: UNAVAILABLE_TEXT }} />}
        {exposed && (
          <InlineNotice
            notice={{ tone: exposure.tone, message: exposure.message }}
          />
        )}
        {notice && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}
        {status?.lastError && phase !== "running" && (
          <p className="text-xs text-feedback-danger-foreground">
            {tr("namedTunnelLastError", "Last error:")} {status.lastError}
          </p>
        )}
      </div>

      <Modal
        isOpen={modalOpen}
        title={tr("namedTunnelModalTitle", "Cloudflare Named Tunnel")}
        onClose={() => !saving && setModalOpen(false)}
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2">
            {status?.configured ? (
              <Button variant="danger" size="sm" disabled={saving} onClick={() => void remove()}>
                {tr("namedTunnelRemove", "Remove settings")}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Button variant="ghost" disabled={saving} onClick={() => setModalOpen(false)}>
                {tr("cancel", "Cancel")}
              </Button>
              <Button variant="secondary" disabled={saving} onClick={() => void save(false)}>
                {tr("namedTunnelSave", "Save")}
              </Button>
              <Button variant="primary" loading={saving} onClick={() => void save(true)}>
                {tr("namedTunnelSaveAndEnable", "Save & enable")}
              </Button>
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-muted">
            <li>
              {tr(
                "namedTunnelHelpCreate",
                "In Cloudflare Zero Trust open Networks > Tunnels and create a tunnel."
              )}
            </li>
            <li>
              {tr(
                "namedTunnelHelpToken",
                "Copy the tunnel token from the install command (the long string after --token or service install)."
              )}
            </li>
            <li>
              {tr(
                "namedTunnelHelpHostname",
                "On the Public Hostnames tab, map your hostname to the service below."
              )}{" "}
              <code className="font-mono text-foreground">
                {(status?.targetUrl ?? "http://127.0.0.1:20128").replace(/^http:\/\/127\.0\.0\.1/, "http://localhost")}
              </code>
            </li>
          </ol>
          <Input
            label={tr("namedTunnelTokenLabel", "Tunnel token")}
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={
              status?.hasToken
                ? tr("namedTunnelTokenSaved", "Saved. Leave blank to keep the current token")
                : tr("namedTunnelTokenPlaceholder", "Paste the tunnel token")
            }
            hint={tr(
              "namedTunnelTokenHint",
              "Stored encrypted and never shown again. It is passed to cloudflared through its environment, not the command line."
            )}
            error={tokenError ?? undefined}
            autoComplete="off"
            spellCheck={false}
            disabled={saving}
            className="font-mono text-sm"
          />
          <Input
            label={tr("namedTunnelHostnameLabel", "Public hostname")}
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            placeholder="ai.example.com"
            hint={tr(
              "namedTunnelHostnameHint",
              "The hostname only, without https:// or a path. Clients will use https://<hostname>/v1."
            )}
            error={hostnameError ?? undefined}
            autoComplete="off"
            spellCheck={false}
            disabled={saving}
          />
        </div>
      </Modal>
    </div>
  );
}

/** Tailscale Serve row: a tailnet-only (private) endpoint. */
export function TailscaleServeRow({
  onStatusChange,
  onRequestInstall,
  bordered = true,
}: {
  onStatusChange?: (status: TailscaleServeTunnelStatus | null) => void;
  onRequestInstall?: () => void;
  /** Draw the divider above the row; off for the first row under a group heading. */
  bordered?: boolean;
}) {
  const tr = useEndpointText();
  const { status, unavailable, refresh, apply } = useTunnelStatus<TailscaleServeTunnelStatus>(
    "/api/tunnels/tailscale-serve",
    onStatusChange
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sudoPassword, setSudoPassword] = useState("");

  const phase: ServePhase = status?.phase ?? "not_installed";
  const pill = SERVE_PILLS[phase];
  const action = servePrimaryAction(status);
  const needsSudo = !!status && status.installed && !status.daemonRunning && status.platform !== "win32";

  const run = async (nextAction: "enable" | "disable") => {
    setBusy(true);
    setNotice(null);
    const { ok, data } = await callTunnelApi("/api/tunnels/tailscale-serve", "POST", {
      action: nextAction,
      ...(nextAction === "enable" && sudoPassword ? { sudoPassword } : {}),
    });
    setSudoPassword("");
    if (!ok || !data) {
      setNotice({
        tone: "danger",
        message: errorText(data) ?? tr("tailscaleServeRequestFailed", "Failed to update Tailscale Serve"),
      });
      await refresh();
    } else {
      if (data.status) apply(data.status as TailscaleServeTunnelStatus);
      if (data.needsLogin && typeof data.authUrl === "string") {
        setNotice({
          tone: "info",
          message: (
            <>
              {tr("tailscaleServeLogin", "Sign this machine in to Tailscale, then enable Serve again.")}{" "}
              <a className="underline" href={data.authUrl} target="_blank" rel="noreferrer">
                {tr("tailscaleServeLoginLink", "Open login page")}
              </a>
            </>
          ),
        });
      } else if (data.funnelActive) {
        setNotice({
          tone: "warning",
          message: tr(
            "tailscaleServeFunnelActive",
            "Tailscale Funnel is publishing this port, so it is public. Stop Funnel first to keep the endpoint private."
          ),
        });
      } else if (data.serveNotEnabled) {
        const enableUrl = typeof data.enableUrl === "string" ? data.enableUrl : null;
        setNotice({
          tone: "warning",
          message: (
            <>
              {tr(
                "tailscaleServeNotEnabled",
                "Serve is not enabled on your tailnet yet. Enable HTTPS in the Tailscale admin console, then try again."
              )}{" "}
              {enableUrl && (
                <a className="underline" href={enableUrl} target="_blank" rel="noreferrer">
                  {tr("tailscaleServeEnableLink", "Open admin console")}
                </a>
              )}
            </>
          ),
        });
      } else {
        setNotice({
          tone: "success",
          message:
            nextAction === "disable"
              ? tr("tailscaleServeStopped", "Tailscale Serve stopped")
              : tr("tailscaleServeStarted", "Tailscale Serve is on for your tailnet"),
        });
      }
    }
    setBusy(false);
  };

  const label =
    action === "install"
      ? tr("tailscaleServeInstall", "Install")
      : action === "stop"
        ? tr("tailscaleServeStop", "Stop Serve")
        : tr("tailscaleServeEnable", "Enable Serve");

  return (
    <div className={bordered ? "border-t border-border/30" : undefined}>
      <div className="flex items-center gap-3 py-3">
        <Icon icon={ShieldCheck} size="md" color="current" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {tr("tailscaleServeTitle", "Tailscale Serve")}
            </span>
            <Badge variant="success" size="sm">
              {tr("tunnelBadgePrivate", "Private")}
            </Badge>
          </div>
          <p className="truncate text-xs text-ink-muted">
            {status?.running && status.tunnelUrl
              ? status.tunnelUrl
              : tr("tailscaleServeSubtitle", "Private — only devices on your tailnet")}
          </p>
        </div>
        <Badge variant={pill.tone}>{pill.label}</Badge>
        {status?.supported !== false && !unavailable && (
          <Button
            size="sm"
            variant={action === "stop" ? "secondary" : "primary"}
            loading={busy}
            onClick={() => {
              if (action === "install") onRequestInstall?.();
              else void run(action === "stop" ? "disable" : "enable");
            }}
            className="shrink-0"
          >
            {label}
          </Button>
        )}
      </div>

      <div className="mb-3 ml-7 flex flex-col gap-2">
        {unavailable && <InlineNotice notice={{ tone: "info", message: UNAVAILABLE_TEXT }} />}
        {needsSudo && action === "enable" && (
          <Input
            label={tr("tailscaleServeSudoLabel", "Sudo password (only if the Tailscale daemon must be started)")}
            type="password"
            value={sudoPassword}
            onChange={(event) => setSudoPassword(event.target.value)}
            autoComplete="off"
            disabled={busy}
            className="font-mono text-sm"
          />
        )}
        {notice && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}
        {status?.publicExposure && !notice && (
          <InlineNotice
            notice={{
              tone: "warning",
              message: tr(
                "tailscaleServeFunnelActive",
                "Tailscale Funnel is publishing this port, so it is public. Stop Funnel first to keep the endpoint private."
              ),
            }}
          />
        )}
        {status?.lastError && phase === "error" && !status.publicExposure && (
          <p className="text-xs text-feedback-danger-foreground">
            {tr("tailscaleServeLastError", "Last error:")} {status.lastError}
          </p>
        )}
      </div>
    </div>
  );
}
