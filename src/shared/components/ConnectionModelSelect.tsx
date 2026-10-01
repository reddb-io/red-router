"use client";

import { useEffect, useState } from "react";
import Select from "./Select";
import Button from "./Button";

export interface ModelConnection {
  id: string;
  provider?: string;
  name?: string;
  displayName?: string;
  email?: string;
  testStatus?: string;
  isActive?: boolean;
}
export interface ConnectionModelValue {
  connectionId: string;
  model: string;
}
interface ModelOption {
  fullModel: string;
  name?: string;
  capabilities?: Record<string, unknown>;
}

export function connectionLabel(connection: ModelConnection): string {
  return [
    connection.provider,
    connection.displayName || connection.name,
    connection.email,
    connection.testStatus,
    connection.id.slice(0, 8),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Connection first; models always come from that account's role-filtered catalog. */
export default function ConnectionModelSelect({
  value,
  onChange,
  role,
  connections: suppliedConnections,
  disabled = false,
}: {
  value: ConnectionModelValue;
  onChange: (value: ConnectionModelValue) => void;
  role: "chat" | "decision";
  connections?: ModelConnection[];
  disabled?: boolean;
}) {
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [connectionsError, setConnectionsError] = useState(false);
  const [retry, setRetry] = useState(0);
  // Catalog state is stamped with its source to hide old-account rows immediately,
  // before effects run, and to reject late responses after a connection change.
  const [source, setSource] = useState("");
  const currentSource = `${value.connectionId}:${role}`;

  useEffect(() => {
    if (suppliedConnections) return;
    const controller = new AbortController();
    setConnectionsError(false);
    fetch("/api/providers", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        const data = await response.json();
        if (!controller.signal.aborted) setConnections(data.connections || []);
      })
      .catch(() => {
        if (!controller.signal.aborted) setConnectionsError(true);
      });
    return () => controller.abort();
  }, [suppliedConnections, retry]);

  useEffect(() => {
    if (!value.connectionId) return;
    const controller = new AbortController();
    setStatus("loading");
    setSource(currentSource);
    setModels([]);
    fetch(
      `/api/providers/${encodeURIComponent(value.connectionId)}/models?excludeHidden=true&capabilities=${role}`,
      {
        cache: "no-store",
        signal: controller.signal,
      }
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        const data = await response.json();
        if (!Array.isArray(data.models)) throw new Error("unavailable");
        if (!controller.signal.aborted) {
          setModels(
            data.models.filter((model: ModelOption) => typeof model.fullModel === "string")
          );
          setStatus("ready");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("error");
      });
    return () => controller.abort();
  }, [value.connectionId, role, currentSource, retry]);

  const active = (suppliedConnections ?? connections).filter(
    (connection) => connection.isActive !== false
  );
  const available = source === currentSource && value.connectionId ? models : [];
  const busy = !!value.connectionId && (source !== currentSource || status === "loading");
  const missingModel = !!value.model && !available.some((model) => model.fullModel === value.model);
  const missingConnection =
    !!value.connectionId && !active.some((connection) => connection.id === value.connectionId);
  const options = available.map((model) => {
    const features =
      role === "chat"
        ? ["reasoning", "tool_calling", "vision", "structured_output"].filter(
            (feature) => model.capabilities?.[feature] === true
          )
        : ["decision"];
    return {
      value: model.fullModel,
      label: `${model.fullModel}${features.length ? ` (${features.map((feature) => ({ tool_calling: "tools", structured_output: "structured output" })[feature] || feature).join(", ")})` : ""}`,
    };
  });
  if (missingModel)
    options.unshift({
      value: value.model,
      label: `${value.model} (saved, unavailable in this catalog)`,
    });

  return (
    <div className="flex flex-col gap-3">
      <Select
        label={role === "decision" ? "System One connection" : "Provider connection"}
        aria-label={role === "decision" ? "System One connection" : "Provider connection"}
        value={value.connectionId}
        options={[
          ...(missingConnection
            ? [{ value: value.connectionId, label: `${value.connectionId} (unavailable)` }]
            : []),
          ...active.map((connection) => ({
            value: connection.id,
            label: connectionLabel(connection),
          })),
        ]}
        placeholder="Choose a connection"
        disabled={disabled}
        onChange={(event) => onChange({ connectionId: event.target.value, model: "" })}
      />
      <Select
        label={role === "decision" ? "System One model" : "Client model"}
        aria-label={role === "decision" ? "System One model" : "Client model"}
        value={value.model}
        options={options}
        placeholder={busy ? "Loading models…" : "Choose a model"}
        disabled={
          disabled || !value.connectionId || missingConnection || busy || status === "error"
        }
        onChange={(event) => onChange({ ...value, model: event.target.value })}
        hint={!value.connectionId ? "Select a connection to see its models." : undefined}
      />
      {connectionsError ||
      (value.connectionId && source === currentSource && status === "error") ? (
        <div role="alert" className="text-sm text-feedback-danger-foreground">
          Could not load the connection catalog.{" "}
          <Button size="sm" variant="secondary" onClick={() => setRetry((current) => current + 1)}>
            Retry
          </Button>
        </div>
      ) : null}
      {value.connectionId && !busy && status === "ready" && available.length === 0 ? (
        <p role="status" className="text-sm text-text-muted">
          {role === "decision"
            ? "This connection has no decision models. Choose another connection or refresh its models in Providers."
            : "This connection has no chat models. Refresh its models in Providers."}
        </p>
      ) : null}
      {!busy && missingModel && value.connectionId ? (
        <p role="status" className="text-sm text-text-muted">
          The saved model is retained. Select an available model before changing this route.
        </p>
      ) : null}
    </div>
  );
}
