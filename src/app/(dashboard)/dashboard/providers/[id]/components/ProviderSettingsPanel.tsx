"use client";

import { useState } from "react";
import { ChevronDown, Pencil, RotateCcw, Settings } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { Badge, Button, Card, ConfirmModal } from "@/shared/components";
import type { ConnectionRowConnection } from "./ConnectionRow";
import {
  connectionConfigRows,
  describeReset,
  resettableKeys,
  type ConfigContext,
  type ResettableKey,
} from "../providerSettingsHelpers";

type PanelConnection = ConnectionRowConnection;

interface PanelNode {
  name?: string;
  prefix?: string;
  baseUrl?: string;
  apiType?: string;
  [key: string]: unknown;
}

interface ProviderSettingsPanelProps {
  providerName: string;
  connections: PanelConnection[];
  context: ConfigContext;
  /** The custom provider (compatible node), when this page is one. */
  providerNode?: PanelNode | null;
  open: boolean;
  onToggle: () => void;
  onEditConnection: (connection: PanelConnection) => void;
  onEditProvider?: () => void;
  onResetConnection: (connection: PanelConnection, keys: ResettableKey[]) => Promise<void>;
}

const connectionLabel = (connection: PanelConnection) =>
  (typeof connection.name === "string" && connection.name.trim()) || connection.id || "Connection";

/**
 * The provider's configuration, at the top of its page: the destination and overrides of each
 * connection, the custom provider's own settings, an Edit button for each, and a way back to the
 * initial configuration. Opened from the Settings button in the page header.
 */
export default function ProviderSettingsPanel({
  providerName,
  connections,
  context,
  providerNode,
  open,
  onToggle,
  onEditConnection,
  onEditProvider,
  onResetConnection,
}: ProviderSettingsPanelProps) {
  const [resetTarget, setResetTarget] = useState<{
    connection: PanelConnection;
    keys: ResettableKey[];
  } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summary =
    connections.length === 0
      ? "No connections yet"
      : `${connections.length} connection${connections.length === 1 ? "" : "s"}`;

  const confirmReset = async () => {
    if (!resetTarget) return;
    setResetting(true);
    setError(null);
    try {
      await onResetConnection(resetTarget.connection, resetTarget.keys);
      setResetTarget(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The reset failed.");
    } finally {
      setResetting(false);
    }
  };

  const targetRows = resetTarget ? connectionConfigRows(resetTarget.connection, context) : [];

  return (
    <Card>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls="provider-settings-panel"
        className="flex w-full items-center gap-3 text-left"
      >
        <span className="rounded-lg bg-primary/10 p-2 text-primary">
          <Icon icon={Settings} size="md" color="current" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-text-main">
            {providerName} settings
          </span>
          <span className="block truncate text-xs text-text-muted">
            {summary}
            {providerNode?.baseUrl ? ` · ${providerNode.baseUrl}` : ""}
          </span>
        </span>
        <span
          className="text-text-muted transition-transform duration-200"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
        >
          <Icon icon={ChevronDown} size="md" color="current" />
        </span>
      </button>

      {open ? (
        <div
          id="provider-settings-panel"
          className="mt-4 flex flex-col gap-4 border-t border-border pt-4"
        >
          {providerNode ? (
            <section className="flex flex-col gap-2" aria-label="Custom provider">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-text-main">Custom provider</h3>
                {onEditProvider ? (
                  <Button size="sm" variant="outline" onClick={onEditProvider}>
                    <Icon icon={Pencil} size="sm" color="current" />
                    Edit provider
                  </Button>
                ) : null}
              </div>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-[8rem_1fr]">
                <dt className="text-text-muted">Name</dt>
                <dd className="text-text-main">{providerNode.name || "—"}</dd>
                <dt className="text-text-muted">Prefix</dt>
                <dd className="font-mono text-text-main">{providerNode.prefix || "—"}</dd>
                <dt className="text-text-muted">Base URL</dt>
                <dd className="break-all font-mono text-text-main">
                  {providerNode.baseUrl || "—"}
                </dd>
                {providerNode.apiType ? (
                  <>
                    <dt className="text-text-muted">API type</dt>
                    <dd className="text-text-main">{providerNode.apiType}</dd>
                  </>
                ) : null}
              </dl>
            </section>
          ) : null}

          <section className="flex flex-col gap-3" aria-label="Connections">
            <h3 className="text-sm font-medium text-text-main">Connections</h3>
            {connections.length === 0 ? (
              <p className="text-xs text-text-muted">
                Nothing to configure yet. Add a connection first.
              </p>
            ) : null}
            {connections.map((connection, index) => {
              const rows = connectionConfigRows(connection, context);
              const keys = resettableKeys(connection, context);
              return (
                <div
                  key={connection.id ?? index}
                  className="flex flex-col gap-2 rounded-md border border-border p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-main">
                      {connectionLabel(connection)}
                    </span>
                    <Badge
                      size="sm"
                      variant={connection.isActive === false ? "warning" : "success"}
                    >
                      {connection.isActive === false ? "Disabled" : "Active"}
                    </Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onEditConnection(connection)}
                    >
                      <Icon icon={Pencil} size="sm" color="current" />
                      Edit
                    </Button>
                    {keys.length > 0 ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setError(null);
                          setResetTarget({ connection, keys });
                        }}
                      >
                        <Icon icon={RotateCcw} size="sm" color="current" />
                        Reset to defaults
                      </Button>
                    ) : null}
                  </div>
                  {rows.length === 0 ? (
                    <p className="text-xs text-text-muted">
                      Using the provider&apos;s default settings.
                    </p>
                  ) : (
                    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-[8rem_1fr]">
                      {rows.map((row) => (
                        <div key={row.key} className="contents">
                          <dt className="text-text-muted">{row.label}</dt>
                          <dd className="flex flex-wrap items-center gap-2 text-text-main">
                            <span className="break-all font-mono">{row.value || "—"}</span>
                            <Badge size="sm" variant={row.overridden ? "primary" : "outline"}>
                              {row.overridden ? "Custom" : "Default"}
                            </Badge>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              );
            })}
          </section>
        </div>
      ) : null}

      <ConfirmModal
        isOpen={resetTarget !== null}
        onClose={() => (resetting ? undefined : setResetTarget(null))}
        onConfirm={confirmReset}
        title="Reset to defaults?"
        message={
          resetTarget ? (
            <div className="flex flex-col gap-2 text-sm">
              <p>
                This puts {connectionLabel(resetTarget.connection)} back to the provider&apos;s
                initial settings. Its API key and credentials are not touched.
              </p>
              <ul className="list-disc ps-5 font-mono text-xs">
                {describeReset(targetRows, resetTarget.keys).map((line) => (
                  <li key={line} className="break-all">
                    {line}
                  </li>
                ))}
              </ul>
              {error ? (
                <p role="alert" className="text-feedback-danger-foreground">
                  {error}
                </p>
              ) : null}
            </div>
          ) : (
            ""
          )
        }
        confirmText="Reset"
        cancelText="Cancel"
        variant="danger"
        loading={resetting}
      />
    </Card>
  );
}
