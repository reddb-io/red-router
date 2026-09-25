"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Button, Badge, Input, Select, Modal, ConfirmModal, Toggle } from "@/shared/components";
import ConnectionTestResult from "@/shared/components/ConnectionTestResult";

const WINDOW_OPTIONS = [
  { value: "300", label: "Every 5 minutes" },
  { value: "900", label: "Every 15 minutes" },
  { value: "1800", label: "Every 30 minutes" },
  { value: "3600", label: "Every hour" },
];
const MODE_OPTIONS = [
  { value: "window", label: "Consolidated per API key, on a schedule" },
  { value: "instant", label: "Every request, as it happens" },
];
const EMPTY_FORM = { name: "", type: "webhook", mode: "window", windowSec: "900", apiKeyIds: [], tags: "" };
const TYPE_OPTIONS = [
  { value: "webhook", label: "Webhook (HTTP POST, signed)" },
  { value: "sqs", label: "Amazon SQS" },
  { value: "kafka", label: "Kafka" },
  { value: "reddb", label: "RedDB queue" },
];
const SASL_OPTIONS = [
  { value: "none", label: "None" },
  { value: "plain", label: "PLAIN" },
  { value: "scram-sha-256", label: "SCRAM-SHA-256" },
  { value: "scram-sha-512", label: "SCRAM-SHA-512" },
];

// Form fields per transport, from a stored sink's public config (secrets stay
// empty: an empty secret keeps the stored one).
function configFields(type, config = {}) {
  if (type === "sqs") return { queueUrl: config.queueUrl || "", region: config.region || "", accessKeyId: config.accessKeyId || "", secretAccessKey: "", sessionToken: "" };
  if (type === "kafka") {
    return {
      brokers: (config.brokers || []).join(", "), topic: config.topic || "", clientId: config.clientId || "red-router", ssl: !!config.ssl,
      saslMechanism: config.sasl?.mechanism || "none", saslUsername: config.sasl?.username || "", saslPassword: "",
    };
  }
  if (type === "reddb") return { reddbUrl: config.url || "", queue: config.queue || "", token: "", tenant: config.tenant || "" };
  return { url: config.url || "", secret: "" };
}

function configBody(type, f) {
  if (type === "sqs") return { queueUrl: f.queueUrl, region: f.region, accessKeyId: f.accessKeyId, secretAccessKey: f.secretAccessKey, sessionToken: f.sessionToken };
  if (type === "kafka") {
    return {
      brokers: f.brokers, topic: f.topic, clientId: f.clientId, ssl: f.ssl,
      sasl: f.saslMechanism && f.saslMechanism !== "none" ? { mechanism: f.saslMechanism, username: f.saslUsername, password: f.saslPassword } : null,
    };
  }
  if (type === "reddb") return { url: f.reddbUrl, queue: f.queue, token: f.token, tenant: f.tenant };
  return { url: f.url, secret: f.secret };
}

const keepHint = (has, hintText) => (has ? `Keep the current one${hintText ? ` (${hintText})` : ""}` : "");

function newSecret() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `whsec_${btoa(String.fromCharCode(...bytes))}`;
}

function modeLabel(sink) {
  if (sink.mode === "instant") return "Every request";
  return WINDOW_OPTIONS.find((o) => Number(o.value) === sink.windowSec)?.label || `Every ${sink.windowSec / 60} min`;
}

function filterLabel(sink, keysById) {
  const f = sink.filter;
  if (!f) return "All API keys";
  const parts = [];
  if (f.apiKeyIds?.length) parts.push(f.apiKeyIds.map((id) => keysById[id]?.name || "deleted key").join(", "));
  if (f.tags?.length) parts.push(`tags: ${f.tags.join(", ")}`);
  return parts.join(" · ");
}

const formatCost = (n) => (typeof n === "number" ? `$${n.toFixed(n < 1 ? 4 : 2)}` : "—");
const formatTime = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

export default function UsageSinksPage() {
  const [sinks, setSinks] = useState([]);
  const [apiKeys, setApiKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | "new" | sink
  const [deleting, setDeleting] = useState(null);
  const [openDeliveries, setOpenDeliveries] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [testingId, setTestingId] = useState(null);

  const load = useCallback(async () => {
    const [sinksRes, keysRes] = await Promise.all([fetch("/api/usage-sinks"), fetch("/api/keys")]);
    const sinksData = await sinksRes.json().catch(() => ({}));
    const keysData = await keysRes.json().catch(() => ({}));
    setSinks(sinksData.sinks || []);
    setApiKeys((keysData.keys || []).map(({ id, name, tags }) => ({ id, name, tags: tags || [] })));
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const keysById = Object.fromEntries(apiKeys.map((k) => [k.id, k]));

  const toggleActive = async (sink, isActive) => {
    await fetch(`/api/usage-sinks/${sink.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive }) });
    load();
  };

  const runTest = async (sink) => {
    setTestingId(sink.id);
    try {
      const res = await fetch(`/api/usage-sinks/${sink.id}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = res.ok ? { requests: [], ...(await res.json()) } : { valid: false, error: `HTTP ${res.status}` };
      setTestResults((prev) => ({ ...prev, [sink.id]: result }));
    } finally {
      setTestingId(null);
    }
  };

  const confirmDelete = async () => {
    await fetch(`/api/usage-sinks/${deleting.id}`, { method: "DELETE" });
    setDeleting(null);
    load();
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-sm text-ink-muted">
          Send usage to your billing system by webhook, Amazon SQS, Kafka or a RedDB queue: every request as it happens, or totals per API key every 5, 15, 30 or 60 minutes.
          Each delivery is retried until it lands and carries a stable id so it can be deduplicated; webhooks are signed (Standard Webhooks).
        </p>
        <Button icon="add" onClick={() => setEditing("new")} className="shrink-0">Add sink</Button>
      </div>

      {!loading && sinks.length === 0 && (
        <Card>
          <div className="py-10 text-center">
            <p className="mb-1 font-medium text-foreground">No usage sinks yet</p>
            <p className="text-sm text-ink-muted">Add a sink to start sending usage. It receives usage recorded from then on.</p>
          </div>
        </Card>
      )}

      {sinks.map((sink) => (
        <Card key={sink.id} padding="sm">
          <div className="flex flex-col gap-3">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium text-foreground">{sink.name}</h3>
                  <Badge size="sm" variant={sink.isActive ? "success" : "default"} dot>{sink.isActive ? "Active" : "Paused"}</Badge>
                  <Badge size="sm">{modeLabel(sink)}</Badge>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-ink-muted" title={sink.summary}>{sink.summary}</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {filterLabel(sink, keysById)}
                  {sink.type === "webhook" && ` · ${sink.config.hasSecret ? `signed (${sink.config.secretHint})` : "unsigned"}`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Toggle checked={sink.isActive} onChange={(v) => toggleActive(sink, v)} />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge size="sm" variant="success">{sink.deliveries.delivered} delivered</Badge>
              {sink.deliveries.pending > 0 && <Badge size="sm" variant="warning">{sink.deliveries.pending} pending</Badge>}
              {sink.deliveries.dead > 0 && <Badge size="sm" variant="danger">{sink.deliveries.dead} failed</Badge>}
              <div className="ml-auto flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" icon="send" loading={testingId === sink.id} onClick={() => runTest(sink)}>Send test</Button>
                <Button size="sm" variant="secondary" icon="list" onClick={() => setOpenDeliveries(openDeliveries === sink.id ? null : sink.id)}>
                  Deliveries
                </Button>
                <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing(sink)}>Edit</Button>
                <Button size="sm" variant="ghost" icon="delete" onClick={() => setDeleting(sink)} aria-label={`Delete ${sink.name}`} />
              </div>
            </div>

            <ConnectionTestResult result={testResults[sink.id] || null} testing={testingId === sink.id} />
            {openDeliveries === sink.id && <DeliveriesPanel sinkId={sink.id} onChange={load} />}
          </div>
        </Card>
      ))}

      {editing && (
        <SinkFormModal
          sink={editing === "new" ? null : editing}
          apiKeys={apiKeys}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}

      <ConfirmModal
        isOpen={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title="Delete usage sink"
        message={deleting ? `Delete "${deleting.name}" and its delivery history? Undelivered batches are dropped.` : ""}
        confirmText="Delete"
      />
    </div>
  );
}

function SinkFormModal({ sink, apiKeys, onClose, onSaved }) {
  const [form, setForm] = useState(() => (sink ? {
    name: sink.name,
    type: sink.type,
    ...configFields(sink.type, sink.config),
    mode: sink.mode,
    windowSec: String(sink.windowSec || 900),
    apiKeyIds: sink.filter?.apiKeyIds || [],
    tags: (sink.filter?.tags || []).join(", "),
  } : { ...EMPTY_FORM, ...configFields("webhook"), secret: newSecret() }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  const body = () => ({
    name: form.name,
    type: form.type,
    config: configBody(form.type, form),
    mode: form.mode,
    windowSec: Number(form.windowSec),
    filter: { apiKeyIds: form.apiKeyIds, tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean) },
  });

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(sink ? `/api/usage-sinks/${sink.id}` : "/api/usage-sinks", {
        method: sink ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body()),
      });
      if (res.ok) return onSaved();
      setError((await res.json().catch(() => ({}))).error || `Save failed (HTTP ${res.status})`);
    } finally {
      setSaving(false);
    }
  };

  // Testing an unsaved sink needs somewhere to send from: new sinks test after saving.
  const test = async () => {
    if (!sink) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/usage-sinks/${sink.id}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) });
      setTestResult({ requests: [], ...(await res.json().catch(() => ({ valid: false, error: `HTTP ${res.status}` }))) });
    } finally {
      setTesting(false);
    }
  };

  const toggleKey = (id) => set({ apiKeyIds: form.apiKeyIds.includes(id) ? form.apiKeyIds.filter((k) => k !== id) : [...form.apiKeyIds, id] });

  return (
    <Modal isOpen onClose={onClose} title={sink ? "Edit usage sink" : "Add usage sink"} size="lg">
      <div className="flex flex-col gap-4">
        <Input label="Name" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Billing" />
        <Select
          label="Send to"
          value={form.type}
          onChange={(e) => set({ type: e.target.value, ...configFields(e.target.value), ...(e.target.value === "webhook" ? { secret: newSecret() } : {}) })}
          options={TYPE_OPTIONS}
          disabled={!!sink}
        />
        {form.type === "webhook" && (
          <>
            <Input label="Webhook URL" value={form.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://billing.example.com/hooks/redrouter" />
            <div className="flex items-end gap-2">
              <Input
                className="flex-1"
                label="Signing secret"
                value={form.secret}
                onChange={(e) => set({ secret: e.target.value })}
                placeholder={keepHint(sink?.config.hasSecret, sink?.config.secretHint) || "whsec_…"}
                hint="Verify webhook-signature with it (HMAC-SHA256, Standard Webhooks). Copy it now: it is not shown again."
              />
              <Button variant="secondary" icon="key" onClick={() => set({ secret: newSecret() })}>Generate</Button>
            </div>
          </>
        )}
        {form.type === "sqs" && (
          <>
            <Input
              label="Queue URL"
              value={form.queueUrl}
              onChange={(e) => set({ queueUrl: e.target.value })}
              placeholder="https://sqs.us-east-1.amazonaws.com/123456789012/usage"
              hint="A .fifo queue gets the delivery id as MessageDeduplicationId, so a retry is not enqueued twice."
            />
            <Input label="Region" value={form.region} onChange={(e) => set({ region: e.target.value })} placeholder="Read from the queue URL" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input label="Access key id" value={form.accessKeyId} onChange={(e) => set({ accessKeyId: e.target.value })} placeholder="AKIA…" />
              <Input
                label="Secret access key"
                type="password"
                value={form.secretAccessKey}
                onChange={(e) => set({ secretAccessKey: e.target.value })}
                placeholder={keepHint(sink?.config.hasSecret, sink?.config.secretHint)}
              />
            </div>
            <Input
              label="Session token (optional)"
              type="password"
              value={form.sessionToken}
              onChange={(e) => set({ sessionToken: e.target.value })}
              placeholder={sink?.config.hasSessionToken ? "Keep the current one (type - to remove)" : "For temporary credentials"}
              hint="The key needs sqs:SendMessage on this queue."
            />
          </>
        )}
        {form.type === "kafka" && (
          <>
            <Input label="Brokers" value={form.brokers} onChange={(e) => set({ brokers: e.target.value })} placeholder="broker1:9092, broker2:9092" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input label="Topic" value={form.topic} onChange={(e) => set({ topic: e.target.value })} placeholder="redrouter.usage" hint="The topic must exist." />
              <Input label="Client id" value={form.clientId} onChange={(e) => set({ clientId: e.target.value })} placeholder="red-router" />
            </div>
            <Toggle checked={form.ssl} onChange={(v) => set({ ssl: v })} label="TLS" description="Connect to the brokers over TLS." />
            <Select label="SASL" value={form.saslMechanism} onChange={(e) => set({ saslMechanism: e.target.value })} options={SASL_OPTIONS} />
            {form.saslMechanism !== "none" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Input label="Username" value={form.saslUsername} onChange={(e) => set({ saslUsername: e.target.value })} />
                <Input
                  label="Password"
                  type="password"
                  value={form.saslPassword}
                  onChange={(e) => set({ saslPassword: e.target.value })}
                  placeholder={keepHint(sink?.config.sasl?.hasPassword)}
                />
              </div>
            )}
            <p className="text-xs text-ink-muted">Messages are keyed by sink, so one sink&apos;s deliveries stay in order; the delivery id is in the redrouter-delivery-id header.</p>
          </>
        )}
        {form.type === "reddb" && (
          <>
            <Input label="RedDB URL" value={form.reddbUrl} onChange={(e) => set({ reddbUrl: e.target.value })} placeholder="http://127.0.0.1:5000" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input label="Queue" value={form.queue} onChange={(e) => set({ queue: e.target.value })} placeholder="usage_events" />
              <Input label="Tenant (optional)" value={form.tenant} onChange={(e) => set({ tenant: e.target.value })} />
            </div>
            <Input
              label="Token"
              type="password"
              value={form.token}
              onChange={(e) => set({ token: e.target.value })}
              placeholder={sink?.config.hasToken ? `Keep the current one (${sink.config.tokenHint}; type - to remove)` : "rdb_k_… (not needed without --auth)"}
            />
            <p className="text-xs text-ink-muted">
              Create the queue once: <code>CREATE QUEUE IF NOT EXISTS {form.queue || "usage_events"} WITH DEDUP_WINDOW 1h</code>. Each delivery is pushed with its id as the DEDUP key.
            </p>
          </>
        )}
        <Select label="What to send" value={form.mode} onChange={(e) => set({ mode: e.target.value })} options={MODE_OPTIONS} />
        {form.mode === "window" && (
          <Select label="Window" value={form.windowSec} onChange={(e) => set({ windowSec: e.target.value })} options={WINDOW_OPTIONS} />
        )}

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-foreground">API keys</legend>
          <p className="text-xs text-ink-muted">Leave everything unchecked to send usage for every key, requests without a key included.</p>
          <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {apiKeys.map((k) => (
              <label key={k.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.apiKeyIds.includes(k.id)} onChange={() => toggleKey(k.id)} />
                <span>{k.name || "Unnamed key"}</span>
                {k.tags.length > 0 && <span className="text-xs text-ink-muted">{k.tags.join(", ")}</span>}
              </label>
            ))}
            {apiKeys.length === 0 && <p className="text-xs text-ink-muted">No API keys yet.</p>}
          </div>
          <Input label="Or keys with these tags" value={form.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="customer-a, billable" />
        </fieldset>

        {error && <p className="rounded-md border border-feedback-danger-border bg-feedback-danger-surface px-3 py-2 text-sm text-feedback-danger-foreground" role="alert">{error}</p>}
        <ConnectionTestResult result={testResult} testing={testing} />

        <div className="flex gap-2">
          <Button onClick={save} loading={saving} fullWidth>{sink ? "Save" : "Add sink"}</Button>
          {sink && <Button variant="secondary" icon="send" onClick={test} loading={testing}>Send test</Button>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

function DeliveriesPanel({ sinkId, onChange }) {
  const [deliveries, setDeliveries] = useState(null);
  const [retrying, setRetrying] = useState(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/usage-sinks/${sinkId}/deliveries`);
    setDeliveries((await res.json().catch(() => ({}))).deliveries || []);
  }, [sinkId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const retry = async (d) => {
    setRetrying(d.id);
    try {
      await fetch(`/api/usage-sinks/${sinkId}/deliveries/${d.id}/retry`, { method: "POST" });
      await load();
      onChange();
    } finally {
      setRetrying(null);
    }
  };

  if (!deliveries) return <p className="text-xs text-ink-muted">Loading deliveries…</p>;
  if (!deliveries.length) return <p className="text-xs text-ink-muted">No deliveries yet. Windows with no usage send nothing.</p>;

  return (
    <div className="overflow-x-auto rounded-md border border-muted">
      <table className="w-full text-left text-xs">
        <thead className="text-ink-muted">
          <tr className="border-b border-muted">
            <th className="px-3 py-2 font-medium">Created</th>
            <th className="px-3 py-2 font-medium">Covers</th>
            <th className="px-3 py-2 font-medium">Requests</th>
            <th className="px-3 py-2 font-medium">Cost</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {deliveries.map((d) => (
            <tr key={d.id} className="border-b border-muted last:border-0 align-top">
              <td className="whitespace-nowrap px-3 py-2">{formatTime(d.createdAt)}</td>
              <td className="px-3 py-2">
                {d.kind === "window"
                  ? `${formatTime(d.windowStart)} → ${new Date(d.windowEnd).toLocaleTimeString()}`
                  : d.summary?.model || "1 request"}
                <div className="font-mono text-[11px] text-ink-muted">{d.id}</div>
              </td>
              <td className="px-3 py-2 font-mono tabular-nums">
                {d.summary?.requests ?? "—"}{d.kind === "window" ? ` · ${d.summary?.keys ?? 0} keys` : ""}
              </td>
              <td className="px-3 py-2 font-mono tabular-nums">{formatCost(d.summary?.cost)}</td>
              <td className="px-3 py-2">
                <Badge size="sm" variant={d.status === "delivered" ? "success" : d.status === "dead" ? "danger" : "warning"}>
                  {d.status === "dead" ? "failed" : d.status}{d.lastStatus ? ` · ${d.lastStatus}` : ""}
                </Badge>
                <div className="mt-1 text-ink-muted">
                  {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
                  {d.status === "pending" && d.nextAttemptAt ? ` · next ${new Date(d.nextAttemptAt).toLocaleTimeString()}` : ""}
                </div>
                {d.lastError && d.status !== "delivered" && <div className="mt-1 max-w-xs break-words text-feedback-danger-foreground">{d.lastError}</div>}
              </td>
              <td className="px-3 py-2 text-right">
                {d.status !== "delivered" && (
                  <Button size="sm" variant="secondary" loading={retrying === d.id} onClick={() => retry(d)}>Retry now</Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
