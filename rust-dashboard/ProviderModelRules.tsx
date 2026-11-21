import { useEffect, useState } from "react";
import { providerModelRules, type ProviderModelRulesView } from "./api/browserClient";
import { Button, Card } from "./components";

export default function ProviderModelRules({ id }: { id: string }) {
  return <Editor key={id} id={id} />;
}

function Editor({ id }: { id: string }) {
  const [view, setView] = useState<ProviderModelRulesView | null>(null);
  const [draft, setDraft] = useState("");
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    providerModelRules(id).then((next) => {
      if (active) { setView(next); setDraft(next.excluded_models.join("\n")); setError(""); }
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load exclusions");
    });
    return () => { active = false; };
  }, [id, reload]);

  async function save() {
    if (!view) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const next = await providerModelRules(id, {
        excluded_models: draft.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
        revision: view.revision,
      });
      setView(next); setDraft(next.excluded_models.join("\n"));
      setMessage("Model exclusions saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save exclusions");
    } finally { setBusy(false); }
  }

  return (
    <Card title="Excluded models" subtitle="Prevent this account from serving selected models.">
      <p className="text-sm text-text-muted">Enter one model or pattern per line. Use * for any sequence and ? for one character.</p>
      <label className="mt-3 flex flex-col gap-1 text-sm">
        Excluded model patterns
        <textarea className="rounded-lg border border-border bg-surface p-2" rows={4} value={draft}
          disabled={!view || busy} onChange={(event) => setDraft(event.target.value)} />
      </label>
      <div className="mt-3 flex gap-2">
        <Button disabled={!view || busy} onClick={() => void save()}>Save exclusions</Button>
        {error && <Button variant="secondary" disabled={busy} onClick={() => setReload((value) => value + 1)}>Reload exclusions</Button>}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-error">{error}</p>}
      {message && <p role="status" className="mt-2 text-sm">{message}</p>}
    </Card>
  );
}
