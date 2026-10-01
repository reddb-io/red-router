"use client";
import { useEffect, useState } from "react";
import { Button, Select } from "@/shared/components";

type KeyChoice = { id: string; name: string; tenantId: string };
type Preview = {
  policy: {
    transparent: boolean;
    providerPriority: string[];
    source: { transparent: string; providerPriority: string };
  };
  models: { id: string; name: string }[];
  targets: { id: string; provider: string; position: number }[];
  reason?: string;
  note: string;
};

export default function RoutingPreview({ tenantId }: { tenantId?: string }) {
  const [keys, setKeys] = useState<KeyChoice[]>([]);
  const [keyId, setKeyId] = useState("");
  const [kind, setKind] = useState("chat");
  const [model, setModel] = useState("");
  const [choicesError, setChoicesError] = useState("");
  const [result, setResult] = useState<{ key: string; data?: Preview; error?: string } | null>(
    null
  );
  const [refresh, setRefresh] = useState(0);
  const requestKey = `${tenantId ?? ""}:${keyId}:${kind}:${model}:${refresh}`;
  const preview = result?.key === requestKey ? result.data : null;
  const error = result?.key === requestKey ? result.error : choicesError;
  const loading = !(tenantId && !keyId) && result?.key !== requestKey;
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/tenants/resources", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load key choices.");
        const body = await response.json();
        if (!controller.signal.aborted)
          setKeys(
            (body.apiKeys ?? []).filter((key: KeyChoice) => !tenantId || key.tenantId === tenantId)
          );
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setChoicesError(reason instanceof Error ? reason.message : "Unable to load key choices.");
      });
    return () => controller.abort();
  }, [tenantId]);
  useEffect(() => {
    if (tenantId && !keyId) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ kind });
    if (keyId) params.set("apiKeyId", keyId);
    if (model) params.set("model", model);
    void fetch(`/api/routing/preview?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message || "Unable to preview routing.");
        if (!Array.isArray(body.models) || !Array.isArray(body.targets) || !body.policy?.source)
          throw new Error("Unable to preview routing: invalid response.");
        if (!controller.signal.aborted) setResult({ key: requestKey, data: body });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            key: requestKey,
            error: reason instanceof Error ? reason.message : "Unable to preview routing.",
          });
      });
    return () => controller.abort();
  }, [keyId, model, kind, tenantId, refresh, requestKey]);
  return (
    <section
      aria-label="Effective routing preview"
      className="space-y-4 border-t border-border pt-5"
    >
      <h2 className="text-lg font-semibold">Effective routing preview</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="API key scope"
          value={keyId}
          options={[
            { value: "", label: tenantId ? "Choose a tenant key" : "Instance catalog" },
            ...keys.map((key) => ({ value: key.id, label: key.name })),
          ]}
          onChange={(event) => {
            setKeyId(event.target.value);
            setModel("");
          }}
        />
        <Select
          label="Model role"
          value={kind}
          options={[
            { value: "chat", label: "System Two / Chat" },
            { value: "decision", label: "System One / Decision" },
          ]}
          onChange={(event) => {
            setKind(event.target.value);
            setModel("");
          }}
        />
      </div>
      {tenantId && !keyId && (
        <p className="text-sm text-text-muted">
          Choose a key to include its tenant, model and connection restrictions.
        </p>
      )}
      {error && (
        <p role="alert" className="text-feedback-danger-foreground">
          {error}
        </p>
      )}
      {loading && (
        <p role="status" className="text-sm text-text-muted">
          Loading authorized routes…
        </p>
      )}
      {preview && (
        <>
          <p className="text-sm text-text-muted">
            Mode: {preview.policy.transparent ? "Transparent" : "Providers hidden"} (
            {preview.policy.source.transparent}). Provider order from{" "}
            {preview.policy.source.providerPriority}.
          </p>
          <Select
            label="Preview model"
            value={model}
            placeholder="Choose a model"
            options={preview.models.map((item) => ({ value: item.id, label: String(item.name) }))}
            onChange={(event) => setModel(event.target.value)}
          />
          {!!preview.targets.length && (
            <ol className="space-y-2 text-sm">
              {preview.targets.map((target) => (
                <li key={target.id} className="break-all font-mono">
                  {target.position}. {target.id}
                </li>
              ))}
            </ol>
          )}
          {preview.reason && (
            <p role="status" className="text-sm text-text-muted">
              {preview.reason}
            </p>
          )}
          <p className="max-w-prose text-xs text-text-muted">{preview.note}</p>
        </>
      )}
      <Button
        variant="ghost"
        disabled={loading || (!!tenantId && !keyId)}
        onClick={() => setRefresh((n) => n + 1)}
      >
        Refresh preview
      </Button>
    </section>
  );
}
