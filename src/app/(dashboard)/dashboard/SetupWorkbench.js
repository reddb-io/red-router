"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Button, Input } from "@/shared/components";

const EMPTY = { connections: [], keys: [] };

function StepStatus({ done, active }) {
  const icon = done ? "check" : active ? "arrow_forward" : "more_horiz";
  return (
    <span className={`setup-step-status ${done ? "is-done" : active ? "is-active" : ""}`} aria-label={done ? "Complete" : active ? "Current step" : "Not started"}>
      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">{icon}</span>
    </span>
  );
}

export default function SetupWorkbench() {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [keyName, setKeyName] = useState("RedRouter default");
  const [creatingKey, setCreatingKey] = useState(false);
  const [createdKey, setCreatedKey] = useState(null);
  const [validation, setValidation] = useState(null);
  const [validating, setValidating] = useState(false);
  const [copied, setCopied] = useState("");
  const baseUrl = useSyncExternalStore(
    () => () => {},
    () => `${globalThis.location.origin}/v1`,
    () => "/v1",
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [providersResponse, keysResponse] = await Promise.all([
        fetch("/api/providers", { cache: "no-store" }),
        fetch("/api/keys", { cache: "no-store" }),
      ]);
      if (!providersResponse.ok || !keysResponse.ok) throw new Error("Setup status is unavailable");
      const [providers, keys] = await Promise.all([providersResponse.json(), keysResponse.json()]);
      const connections = providers.connections || [];
      setData({ connections, keys: keys.keys || [] });
      setSelectedConnectionId((current) => current || connections.find((item) => item.isActive !== false)?.id || connections[0]?.id || "");
    } catch (error) {
      setLoadError(error.message || "Could not load setup status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { queueMicrotask(load); }, [load]);

  const activeConnections = useMemo(() => data.connections.filter((item) => item.isActive !== false && !item.disabledForMe), [data.connections]);
  const hasProvider = activeConnections.length > 0;
  const hasKey = data.keys.some((item) => item.isActive !== false) || !!createdKey;
  const isReady = validation?.status === "ready";
  const configCopied = copied === "snippet";
  const currentStep = !hasProvider ? 1 : !hasKey ? 2 : !configCopied && !isReady ? 3 : 4;
  const secret = createdKey?.key || "YOUR_API_KEY";
  const snippet = `export OPENAI_BASE_URL=${baseUrl}\nexport OPENAI_API_KEY=${secret}`;

  async function copy(value, id) {
    await navigator.clipboard.writeText(value);
    setCopied(id);
    globalThis.setTimeout(() => setCopied(""), 1800);
  }

  async function createKey(event) {
    event.preventDefault();
    if (!keyName.trim()) return;
    setCreatingKey(true);
    try {
      const response = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: keyName.trim(), tags: ["setup"] }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not create API key");
      setCreatedKey(result);
      setData((current) => ({ ...current, keys: [...current.keys, { ...result, isActive: true }] }));
    } catch (error) {
      setLoadError(error.message || "Could not create API key");
    } finally {
      setCreatingKey(false);
    }
  }

  async function validateSetup() {
    setValidating(true);
    setValidation(null);
    try {
      const response = await fetch("/api/setup/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: selectedConnectionId }),
      });
      const result = await response.json();
      setValidation(result);
    } catch {
      setValidation({ status: "error", checks: [{ id: "server", status: "fail", message: "The validation request could not reach RedRouter." }] });
    } finally {
      setValidating(false);
    }
  }

  return (
    <div className="setup-workbench" aria-busy={loading}>
      <header className="setup-heading">
        <div>
          <p className="setup-kicker">SETUP / ROUTER</p>
          <h1>Get RedRouter ready</h1>
          <p>Connect one provider, issue a key, then validate the route. Advanced networking stays out of the way until you need it.</p>
        </div>
        <div className={`setup-readiness ${isReady ? "is-ready" : ""}`} role="status">
          <span className="status-dot" aria-hidden="true" />
          {isReady ? "Ready" : loading ? "Checking" : `Step ${currentStep} of 4`}
        </div>
      </header>

      {loadError ? <div className="setup-alert is-error" role="alert">{loadError} <button type="button" onClick={load}>Retry</button></div> : null}

      <ol className="setup-steps">
        <li className={currentStep === 1 ? "is-current" : ""}>
          <StepStatus done={hasProvider} active={currentStep === 1} />
          <div className="setup-step-copy">
            <span className="setup-step-number">01</span>
            <h2>Connect a provider</h2>
            <p>{hasProvider ? `${activeConnections.length} active connection${activeConnections.length === 1 ? "" : "s"}.` : "RedRouter needs one upstream account before it can route requests."}</p>
          </div>
          <div className="setup-step-action">
            {hasProvider ? (
              <select value={selectedConnectionId} onChange={(event) => setSelectedConnectionId(event.target.value)} aria-label="Provider connection used for validation">
                {activeConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName || connection.name || connection.provider}</option>)}
              </select>
            ) : null}
            <Link href="/dashboard/providers" className="setup-link">{hasProvider ? "Manage providers" : "Connect provider"}<span aria-hidden="true">→</span></Link>
          </div>
        </li>

        <li className={currentStep === 2 ? "is-current" : ""}>
          <StepStatus done={hasKey} active={currentStep === 2} />
          <div className="setup-step-copy">
            <span className="setup-step-number">02</span>
            <h2>Create an API key</h2>
            <p>{hasKey ? "A usable client key exists." : "Clients use this key to authenticate with your router."}</p>
          </div>
          <div className="setup-step-action">
            {!hasKey ? (
              <form className="setup-inline-form" onSubmit={createKey}>
                <Input value={keyName} onChange={(event) => setKeyName(event.target.value)} aria-label="API key name" />
                <Button type="submit" size="sm" loading={creatingKey}>Create key</Button>
              </form>
            ) : <Link href="/dashboard/endpoint#api-keys" className="setup-link">Manage keys<span aria-hidden="true">→</span></Link>}
          </div>
        </li>

        <li className={currentStep === 3 ? "is-current" : ""}>
          <StepStatus done={configCopied || isReady} active={currentStep === 3} />
          <div className="setup-step-copy">
            <span className="setup-step-number">03</span>
            <h2>Configure your client</h2>
            <p>Use the OpenAI-compatible endpoint in any supported client.</p>
          </div>
          <div className="setup-code-wrap">
            {createdKey ? <p className="setup-secret-note">This new key is shown once. Copy it before leaving this page.</p> : null}
            <pre><code>{snippet}</code></pre>
            <Button variant="secondary" size="sm" icon={copied === "snippet" ? "check" : "content_copy"} onClick={() => copy(snippet, "snippet")}>{copied === "snippet" ? "Copied" : "Copy config"}</Button>
          </div>
        </li>

        <li className={currentStep === 4 ? "is-current" : ""}>
          <StepStatus done={isReady} active={currentStep === 4} />
          <div className="setup-step-copy">
            <span className="setup-step-number">04</span>
            <h2>Validate the route</h2>
            <p>Checks this server, the selected provider connection and key availability without running a paid completion.</p>
          </div>
          <div className="setup-step-action">
            <Button onClick={validateSetup} disabled={!hasProvider || !hasKey} loading={validating}>{isReady ? "Run again" : "Run validation"}</Button>
          </div>
          {validation ? (
            <ul className="setup-checks" aria-live="polite">
              {validation.checks?.map((check) => <li key={check.id} className={check.status === "pass" ? "is-pass" : "is-fail"}><span className="material-symbols-outlined" aria-hidden="true">{check.status === "pass" ? "check_circle" : "error"}</span>{check.message}</li>)}
            </ul>
          ) : null}
        </li>
      </ol>

      {isReady ? <div className="setup-success" role="status"><span className="material-symbols-outlined" aria-hidden="true">check_circle</span><div><strong>Router ready.</strong><p>Your endpoint and selected provider passed validation.</p></div><Link href="/dashboard/usage">Open usage →</Link></div> : null}
    </div>
  );
}
