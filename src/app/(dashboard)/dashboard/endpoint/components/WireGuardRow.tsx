"use client";

import { Check, Copy, Download, Network, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import Icon from "@/shared/components/Icon";
import { Badge, Button, Checkbox, ConfirmModal, Input, Modal, Textarea } from "@/shared/components";
import {
  WG_DEFAULT_ADDRESS,
  WG_DEFAULT_INTERFACE_NAME,
  WG_DEFAULT_LISTEN_PORT,
  checkPeerName,
  checkWireGuardAddress,
  checkWireGuardDns,
  checkWireGuardEndpointHost,
  checkWireGuardInterfaceName,
  checkWireGuardPort,
} from "@/shared/validation/wireguardSchemas";
import {
  InlineNotice,
  UNAVAILABLE_TEXT,
  callTunnelApi,
  errorText,
  useEndpointText,
  useTunnelStatus,
  type Notice,
} from "./TunnelExtras";
import { WIREGUARD_PILLS, type WireGuardPhase } from "./tunnelPresentation";

/** Shapes returned by GET /api/tunnels/wireguard (public keys only; no secret is ever part of it). */
export type WireGuardPeerInfo = {
  id: string;
  name: string;
  publicKey: string;
  allowedIp: string;
  createdAt: string;
  hasPresharedKey: boolean;
};

export type WireGuardConfigInfo = {
  interfaceName: string;
  address: string;
  listenPort: number;
  endpointHost: string;
  dns: string;
  serverPublicKey: string;
  peers: WireGuardPeerInfo[];
};

export type WireGuardStatusInfo = {
  state: WireGuardPhase;
  configured: boolean;
  interfaceUp: boolean;
  activeInterface: string | null;
  interfaceName: string | null;
  address: string | null;
  serverIp: string | null;
  listenPort: number | null;
  endpointHost: string | null;
  peerCount: number;
  apiPort: number;
  apiUrl: string | null;
  bind: {
    host: string;
    reachable: boolean;
    warning: string | null;
    note: string | null;
  } | null;
  commands: { up: string; down: string; status: string } | null;
  reachable: boolean;
  message: string;
  firewallHint: string | null;
};

export type WireGuardOverview = { config: WireGuardConfigInfo | null; status: WireGuardStatusInfo };

type CreatedPeer = { peer: WireGuardPeerInfo; config: string; filename: string; notice: string };

const BASE_URL = "/api/tunnels/wireguard";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function saveTextFile(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A monospace command with a copy button. */
function CommandLine({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-ink-muted">{label}</span>
      <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-surface px-3 py-2">
        <code className="min-w-0 flex-1 break-all font-mono text-xs text-foreground">{command}</code>
        <button
          type="button"
          aria-label={`Copy: ${command}`}
          onClick={async () => {
            setCopied(await copyText(command));
            setTimeout(() => setCopied(false), 1500);
          }}
          className="shrink-0 rounded p-1 transition-colors hover:bg-surface/40"
        >
          <Icon icon={copied ? Check : Copy} size="sm" color="current" />
        </button>
      </div>
    </div>
  );
}

/** WireGuard row: a private endpoint over a VPN the operator brings up on the host. */
export function WireGuardRow({
  onStatusChange,
  bordered = true,
}: {
  onStatusChange?: (status: WireGuardStatusInfo | null) => void;
  /** Draw the divider above the row; off for the first row under a group heading. */
  bordered?: boolean;
}) {
  const tr = useEndpointText();
  const { status: overview, unavailable, refresh, apply } = useTunnelStatus<WireGuardOverview>(
    BASE_URL,
    (next) => onStatusChange?.(next?.status ?? null)
  );
  const status = overview?.status ?? null;
  const config = overview?.config ?? null;
  const phase: WireGuardPhase = status?.state ?? "not_configured";
  const pill = WIREGUARD_PILLS[phase];
  const peers = config?.peers ?? [];

  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  // Settings modal
  const [configOpen, setConfigOpen] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [address, setAddress] = useState("");
  const [ifaceName, setIfaceName] = useState("");
  const [dns, setDns] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Add-peer modal
  const [peerOpen, setPeerOpen] = useState(false);
  const [peerName, setPeerName] = useState("");
  const [usePsk, setUsePsk] = useState(true);
  const [peerError, setPeerError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedPeer | null>(null);
  const [copied, setCopied] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<WireGuardPeerInfo | null>(null);
  const [deleting, setDeleting] = useState(false);

  const openConfig = () => {
    setHost(config?.endpointHost ?? "");
    setPort(String(config?.listenPort ?? WG_DEFAULT_LISTEN_PORT));
    setAddress(config?.address ?? WG_DEFAULT_ADDRESS);
    setIfaceName(config?.interfaceName ?? WG_DEFAULT_INTERFACE_NAME);
    setDns(config?.dns ?? "");
    setErrors({});
    setConfigOpen(true);
  };

  const saveConfig = async () => {
    const checks = {
      endpointHost: checkWireGuardEndpointHost(host),
      listenPort: checkWireGuardPort(port),
      address: checkWireGuardAddress(address),
      interfaceName: checkWireGuardInterfaceName(ifaceName),
      dns: checkWireGuardDns(dns),
    };
    const nextErrors: Record<string, string> = {};
    for (const [field, result] of Object.entries(checks)) {
      if (!result.ok) nextErrors[field] = result.reason as string;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    const { ok, data } = await callTunnelApi(`${BASE_URL}/config`, "PUT", {
      endpointHost: checks.endpointHost.value,
      listenPort: checks.listenPort.value,
      address: checks.address.value,
      interfaceName: checks.interfaceName.value,
      dns: checks.dns.value,
    });
    setSaving(false);
    if (!ok) {
      setErrors({
        endpointHost: errorText(data) ?? tr("wireguardSaveFailed", "Could not save the WireGuard settings"),
      });
      return;
    }
    setConfigOpen(false);
    if (data?.config) apply(data as unknown as WireGuardOverview);
    setNotice({
      tone: "success",
      message: tr(
        "wireguardSaved",
        "Saved. Download the server config, then bring the interface up on this machine."
      ),
    });
  };

  const openAddPeer = () => {
    setPeerName("");
    setUsePsk(true);
    setPeerError(null);
    setCreated(null);
    setCopied(false);
    setPeerOpen(true);
  };

  const closeAddPeer = () => {
    // The private key only ever lives in this state: dropping it here is the point of "shown once".
    setPeerOpen(false);
    setCreated(null);
    setPeerName("");
    setCopied(false);
  };

  const createPeer = async () => {
    const checked = checkPeerName(peerName);
    if (!checked.ok) {
      setPeerError(checked.reason as string);
      return;
    }
    setPeerError(null);
    setCreating(true);
    const { ok, data } = await callTunnelApi(`${BASE_URL}/peers`, "POST", {
      name: checked.value,
      usePresharedKey: usePsk,
    });
    setCreating(false);
    if (!ok || typeof data?.config !== "string") {
      setPeerError(errorText(data) ?? tr("wireguardPeerFailed", "Could not add the peer"));
      return;
    }
    setCreated(data as unknown as CreatedPeer);
    await refresh();
  };

  const removePeer = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const { ok, data } = await callTunnelApi(
      `${BASE_URL}/peers/${encodeURIComponent(deleteTarget.id)}`,
      "DELETE"
    );
    setDeleting(false);
    setDeleteTarget(null);
    if (ok && data?.config) {
      apply(data as unknown as WireGuardOverview);
      setNotice({
        tone: "info",
        message:
          typeof data.notice === "string"
            ? data.notice
            : tr("wireguardPeerRemoved", "Peer removed"),
      });
    } else {
      setNotice({
        tone: "danger",
        message: errorText(data) ?? tr("wireguardPeerRemoveFailed", "Could not remove the peer"),
      });
      await refresh();
    }
  };

  const downloadServerConf = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`${BASE_URL}/server-conf`, { cache: "no-store" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        setNotice({
          tone: "danger",
          message:
            errorText(data) ?? tr("wireguardDownloadFailed", "Could not build the server config"),
        });
      } else {
        const text = await res.text();
        saveTextFile(`${config?.interfaceName ?? WG_DEFAULT_INTERFACE_NAME}.conf`, text);
        setNotice({
          tone: "info",
          message: tr(
            "wireguardDownloaded",
            "The server config contains the server private key. Keep it private and run chmod 600 on it."
          ),
        });
      }
    } catch {
      setNotice({
        tone: "danger",
        message: tr("wireguardDownloadFailed", "Could not build the server config"),
      });
    }
    setBusy(false);
  };

  const stateNotice: { tone: Notice["tone"]; message: ReactNode } | null = !status?.configured
    ? null
    : phase === "interface_up" && status.reachable
      ? { tone: "success", message: status.message }
      : phase === "configured_interface_down"
        ? { tone: "info", message: status.message }
        : null;

  return (
    <div className={bordered ? "border-t border-border/30" : undefined}>
      <div className="flex items-center gap-3 py-3">
        <Icon icon={Network} size="md" color="current" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{tr("wireguardTitle", "WireGuard")}</span>
            <Badge variant="success" size="sm">
              {tr("tunnelBadgePrivate", "Private")}
            </Badge>
          </div>
          <p className="truncate text-xs text-ink-muted">
            {phase === "interface_up" && status?.apiUrl
              ? status.apiUrl
              : tr("wireguardSubtitle", "Private — a VPN you bring up on this machine")}
          </p>
        </div>
        <Badge variant={pill.tone}>{pill.label}</Badge>
        {!unavailable && (
          <div className="flex shrink-0 items-center gap-2">
            {status?.configured && (
              <Button
                size="sm"
                variant="secondary"
                loading={busy}
                onClick={() => void downloadServerConf()}
              >
                {tr("wireguardDownloadServer", "Download server config")}
              </Button>
            )}
            <Button
              size="sm"
              variant={status?.configured ? "ghost" : "primary"}
              disabled={busy}
              onClick={openConfig}
            >
              {status?.configured ? tr("wireguardEdit", "Edit") : tr("wireguardSetUp", "Set up")}
            </Button>
          </div>
        )}
      </div>

      <div className="mb-3 ml-7 flex flex-col gap-3">
        {unavailable && <InlineNotice notice={{ tone: "info", message: UNAVAILABLE_TEXT }} />}
        {notice && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}
        {stateNotice && <InlineNotice notice={stateNotice} />}
        {status?.bind && !status.bind.reachable && status.bind.warning && (
          <InlineNotice notice={{ tone: "warning", message: status.bind.warning }} />
        )}
        {status?.bind?.note && <InlineNotice notice={{ tone: "info", message: status.bind.note }} />}

        {status?.configured && status.commands && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-ink-muted">
              {tr(
                "wireguardHostCommands",
                "RedRouter never brings the interface up (it needs root). Run these on the machine that runs RedRouter, in the folder where you saved the server config:"
              )}
            </p>
            <CommandLine label={tr("wireguardCommandUp", "Bring the interface up")} command={status.commands.up} />
            <CommandLine
              label={tr("wireguardCommandDown", "Take the interface down")}
              command={status.commands.down}
            />
            {status.firewallHint && <p className="text-xs text-ink-muted">{status.firewallHint}</p>}
          </div>
        )}

        {status?.configured && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                {tr("wireguardPeers", "Peers")} ({peers.length})
              </p>
              <Button size="sm" variant="secondary" onClick={openAddPeer} disabled={unavailable}>
                <span className="inline-flex items-center gap-1">
                  <Icon icon={Plus} size="sm" color="current" />
                  {tr("wireguardAddPeer", "Add peer")}
                </span>
              </Button>
            </div>
            {peers.length === 0 ? (
              <p className="text-xs text-ink-muted">
                {tr("wireguardNoPeers", "No peers yet. Add a device to get its WireGuard config.")}
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border/30 rounded-lg border border-border/40">
                {peers.map((peer) => (
                  <li key={peer.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{peer.name}</p>
                      <p className="font-mono text-xs text-ink-muted">{peer.allowedIp}</p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Delete ${peer.name}`}
                      onClick={() => setDeleteTarget(peer)}
                      className="shrink-0 rounded p-1 transition-colors hover:bg-surface/40"
                    >
                      <Icon icon={Trash2} size="sm" color="feedback-danger-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <Modal
        isOpen={configOpen}
        title={tr("wireguardModalTitle", "WireGuard")}
        onClose={() => !saving && setConfigOpen(false)}
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" disabled={saving} onClick={() => setConfigOpen(false)}>
              {tr("cancel", "Cancel")}
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void saveConfig()}>
              {tr("wireguardSave", "Save")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-muted">
            {tr(
              "wireguardHelp",
              "RedRouter generates the keys and config files. You bring the interface up on this machine. Only the RedRouter address travels through the VPN; the rest of a peer's traffic is untouched."
            )}
          </p>
          <Input
            label={tr("wireguardHostLabel", "Endpoint host")}
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="vpn.example.com"
            hint={tr(
              "wireguardHostHint",
              "The public hostname or IP address your devices connect to. Host only, no scheme or port."
            )}
            error={errors.endpointHost}
            autoComplete="off"
            spellCheck={false}
            disabled={saving}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label={tr("wireguardPortLabel", "Listen port (UDP)")}
              value={port}
              onChange={(event) => setPort(event.target.value)}
              inputMode="numeric"
              error={errors.listenPort}
              autoComplete="off"
              disabled={saving}
            />
            <Input
              label={tr("wireguardInterfaceLabel", "Interface name")}
              value={ifaceName}
              onChange={(event) => setIfaceName(event.target.value)}
              error={errors.interfaceName}
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </div>
          <Input
            label={tr("wireguardAddressLabel", "Tunnel address")}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            hint={
              peers.length > 0
                ? tr("wireguardAddressLocked", "Remove all peers before changing the tunnel address.")
                : tr(
                    "wireguardAddressHint",
                    "RedRouter's address inside the VPN, as a private IPv4 range such as 10.99.0.1/24."
                  )
            }
            error={errors.address}
            autoComplete="off"
            spellCheck={false}
            disabled={saving || peers.length > 0}
          />
          <Input
            label={tr("wireguardDnsLabel", "DNS servers (optional)")}
            value={dns}
            onChange={(event) => setDns(event.target.value)}
            placeholder="1.1.1.1"
            hint={tr(
              "wireguardDnsHint",
              "Written into peer configs only when set. Leave blank to keep each device's own DNS."
            )}
            error={errors.dns}
            autoComplete="off"
            spellCheck={false}
            disabled={saving}
          />
        </div>
      </Modal>

      <Modal
        isOpen={peerOpen}
        title={created ? tr("wireguardPeerReady", "Peer config") : tr("wireguardAddPeer", "Add peer")}
        onClose={() => !creating && closeAddPeer()}
        closeOnOverlay={!created}
        size="lg"
        footer={
          created ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="secondary"
                onClick={async () => {
                  setCopied(await copyText(created.config));
                }}
              >
                {copied ? tr("wireguardCopied", "Copied") : tr("wireguardCopy", "Copy")}
              </Button>
              <Button variant="secondary" onClick={() => saveTextFile(created.filename, created.config)}>
                <span className="inline-flex items-center gap-1">
                  <Icon icon={Download} size="sm" color="current" />
                  {tr("wireguardDownload", "Download")}
                </span>
              </Button>
              <Button variant="primary" onClick={closeAddPeer}>
                {tr("wireguardDone", "Done")}
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" disabled={creating} onClick={closeAddPeer}>
                {tr("cancel", "Cancel")}
              </Button>
              <Button variant="primary" loading={creating} onClick={() => void createPeer()}>
                {tr("wireguardCreatePeer", "Create peer")}
              </Button>
            </div>
          )
        }
      >
        {created ? (
          <div className="flex flex-col gap-3">
            <InlineNotice
              notice={{
                tone: "warning",
                message: (
                  <>
                    <strong>
                      {tr("wireguardShownOnce", "This is the only time this private key is shown.")}
                    </strong>{" "}
                    {tr(
                      "wireguardShownOnceDetail",
                      "RedRouter does not store it. Copy or download the file now and import it into the WireGuard app on the device. If you lose it, delete the peer and add it again."
                    )}
                  </>
                ),
              }}
            />
            <Textarea
              readOnly
              rows={14}
              value={created.config}
              spellCheck={false}
              aria-label={tr("wireguardConfigLabel", "Peer WireGuard config")}
              className="font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />
            <p className="text-xs text-ink-muted">
              {tr(
                "wireguardAfterPeer",
                "Then download the server config again and reload the interface on this machine so it accepts the new peer."
              )}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Input
              label={tr("wireguardPeerNameLabel", "Device name")}
              value={peerName}
              onChange={(event) => setPeerName(event.target.value)}
              placeholder="Phone"
              hint={tr("wireguardPeerNameHint", "Only used as a label. Up to 64 characters.")}
              error={peerError ?? undefined}
              autoComplete="off"
              disabled={creating}
              maxLength={200}
            />
            <Checkbox
              id="wireguard-use-psk"
              checked={usePsk}
              onChange={(event) => setUsePsk(event.target.checked)}
              disabled={creating}
              label={tr("wireguardPsk", "Add a preshared key (extra protection, recommended)")}
            />
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={deleteTarget !== null}
        onClose={() => !deleting && setDeleteTarget(null)}
        onConfirm={() => void removePeer()}
        title={tr("wireguardDeleteTitle", "Delete peer")}
        message={
          <>
            {tr("wireguardDeleteMessage", "Remove")} <strong>{deleteTarget?.name}</strong>
            {tr(
              "wireguardDeleteMessageTail",
              "? Download the server config and reload the interface for it to stop being accepted."
            )}
          </>
        }
        confirmText={tr("wireguardDelete", "Delete")}
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
