import { useEffect, useState } from "react";
import { Button, Card } from "./components";
import {
  providerDefinitionHeaders,
  providerRequestHeaders,
  type ProviderHeadersView,
} from "./api/browserClient";

type Scope = "connection" | "definition";
export default function ProviderHeaders({
  id,
  scope = "connection",
}: {
  id: string;
  scope?: Scope;
}) {
  return <ProviderHeadersEditor key={`${scope}:${id}`} id={id} scope={scope} />;
}

function ProviderHeadersEditor({ id, scope }: { id: string; scope: Scope }) {
  const shared = scope === "definition";
  const fetchHeaders = shared ? providerDefinitionHeaders : providerRequestHeaders;
  const [view, setView] = useState<ProviderHeadersView | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    fetchHeaders(id)
      .then((value) => {
        if (active) {
          setView(value);
          setError("");
        }
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load headers");
      });
    return () => {
      active = false;
    };
  }, [id, reload, fetchHeaders]);

  async function save(clear: boolean) {
    setError("");
    setMessage("");
    try {
      const headers: unknown = clear ? {} : JSON.parse(draft);
      if (
        !headers ||
        typeof headers !== "object" ||
        Array.isArray(headers) ||
        !Object.values(headers).every((value) => typeof value === "string")
      ) {
        throw new Error("Enter a JSON object with header names and string values");
      }
      if (!clear && Object.keys(headers).length === 0)
        throw new Error("Enter headers or use Remove all headers");
      setBusy(true);
      setView(await fetchHeaders(id, headers as Record<string, string>));
      setDraft("");
      setMessage(clear ? "Custom headers removed." : "Custom headers saved and activated.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save headers");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={shared ? "Shared request headers" : "Custom request headers"}
      subtitle={
        shared
          ? "Default headers for every account linked to this provider definition. Matching account headers take precedence."
          : "Additional headers for this API connection, such as HTTP-Referer and X-Title. Shared definition headers still apply unless overridden here."
      }
    >
      <p className="text-sm text-text-muted">
        Values are stored encrypted and are never returned here. Saving replaces the entire map.
        Editing metadata preserves it; changing the endpoint, protocol or provider prefix detaches
        it.
      </p>
      {view && <p className="mt-2 text-sm">Configured: {view.names.join(", ") || "None"}</p>}
      {view && !view.attached && (
        <p className="mt-2 text-sm text-warning">
          The destination changed. These headers are inactive. Replace or remove them.
        </p>
      )}
      <label className="mt-3 flex flex-col gap-1 text-sm">
        {shared ? "Shared replacement headers (JSON)" : "Replacement headers (JSON)"}
        <textarea
          className="min-h-28 rounded-lg border border-border bg-surface p-3 font-mono text-sm"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={busy || !view}
          autoComplete="off"
          spellCheck={false}
          placeholder={'{"HTTP-Referer":"https://example.com","X-Title":"My application"}'}
        />
      </label>
      <p className="mt-2 text-xs text-text-muted">
        Up to 16 headers. Authentication, Host, forwarding and connection headers are reserved.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mt-2 text-sm">
          {message}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={!view || !draft.trim()} loading={busy} onClick={() => void save(false)}>
          {shared ? "Replace shared headers" : "Replace headers"}
        </Button>
        <Button
          variant="secondary"
          disabled={!view?.names.length || busy}
          onClick={() => void save(true)}
        >
          {shared ? "Remove shared headers" : "Remove all headers"}
        </Button>
        {!view && error && (
          <Button variant="secondary" onClick={() => setReload((value) => value + 1)}>
            Retry headers
          </Button>
        )}
      </div>
    </Card>
  );
}
