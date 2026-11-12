import { useCallback, useEffect, useState } from "react";
import {
  createRustSharedBudget,
  deleteRustSharedBudget,
  listRustClientKeys,
  listRustSharedBudgets,
  replaceRustSharedBudget,
  type RustClientKey,
  type RustSharedBudget,
  type RustSharedBudgetDuration,
  type RustSharedBudgetInput,
} from "./api/browserClient";

type Draft = {
  id: string | null;
  tenantId: string;
  name: string;
  maximum: string;
  reservation: string;
  duration: RustSharedBudgetDuration;
  enabled: boolean;
  keyIds: string[];
  tags: string;
  users: string;
};

const emptyDraft: Draft = {
  id: null,
  tenantId: "red",
  name: "",
  maximum: "",
  reservation: "0.10",
  duration: "monthly",
  enabled: true,
  keyIds: [],
  tags: "",
  users: "",
};

const inputClass = "w-full rounded border border-border bg-surface px-3 py-2 text-text-main";

function input(draft: Draft): RustSharedBudgetInput {
  const max = Number(draft.maximum);
  const reservation = Number(draft.reservation);
  if (!draft.name.trim() || draft.name.trim().length > 128) {
    throw new Error("Budget name must contain between 1 and 128 characters.");
  }
  if (!Number.isFinite(max) || max <= 0) throw new Error("Maximum spend must be positive.");
  if (!Number.isFinite(reservation) || reservation <= 0 || reservation > max) {
    throw new Error("Reservation must be positive and cannot exceed the budget.");
  }
  return {
    tenant_id: draft.tenantId.trim() || "red",
    name: draft.name.trim(),
    max_spend_usd: max,
    reservation_spend_usd: reservation,
    duration: draft.duration,
    enabled: draft.enabled,
    key_ids: draft.keyIds,
    tags: draft.tags
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean),
    users: draft.users
      .split(",")
      .map((user) => user.trim())
      .filter(Boolean),
  };
}

function fromBudget(budget: RustSharedBudget): Draft {
  return {
    id: budget.id,
    tenantId: budget.tenant_id,
    name: budget.name,
    maximum: String(budget.max_spend_usd),
    reservation: String(budget.reservation_spend_usd),
    duration: budget.duration,
    enabled: budget.enabled,
    keyIds: budget.key_ids,
    tags: budget.tags.join(", "),
    users: budget.users.join(", "),
  };
}

export default function SharedBudgets() {
  const [budgets, setBudgets] = useState<RustSharedBudget[]>([]);
  const [keys, setKeys] = useState<RustClientKey[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(() => Promise.all([listRustSharedBudgets(), listRustClientKeys()]), []);

  useEffect(() => {
    let active = true;
    void load()
      .then(([budgetRows, keyRows]) => {
        if (!active) return;
        setBudgets(budgetRows);
        setKeys(keyRows);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Cannot load budgets");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = input(draft);
      if (draft.id) await replaceRustSharedBudget(draft.id, payload);
      else await createRustSharedBudget(payload);
      setDraft(emptyDraft);
      const [budgetRows, keyRows] = await load();
      setBudgets(budgetRows);
      setKeys(keyRows);
      setNotice("Shared budget saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cannot save budget");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (budget: RustSharedBudget) => {
    if (!window.confirm(`Delete shared budget “${budget.name}”?`)) return;
    setBusy(true);
    setError("");
    try {
      await deleteRustSharedBudget(budget.id);
      if (draft.id === budget.id) setDraft(emptyDraft);
      const [budgetRows, keyRows] = await load();
      setBudgets(budgetRows);
      setKeys(keyRows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cannot delete budget");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <main className="p-6">Loading shared budgets…</main>;
  return (
    <main className="space-y-6 p-4 md:p-6" id="main-content">
      <header>
        <h1 className="text-2xl font-semibold">Shared budgets</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">
          Enforce one spend ceiling across an organization, client keys, request tags, or end users.
          Admission and holds are serialized by SQLite across every Rust proxy process.
        </p>
      </header>
      {error && (
        <p role="alert" className="rounded border border-error/30 p-3 text-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded border border-success/30 p-3 text-success">
          {notice}
        </p>
      )}

      <section className="space-y-4 rounded-xl border border-border bg-surface/50 p-4">
        <h2 className="font-semibold">{draft.id ? `Edit ${draft.name}` : "Create a budget"}</h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <label className="text-sm">
            Name
            <input
              className={inputClass}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="text-sm">
            Organization
            <input
              className={inputClass}
              value={draft.tenantId}
              disabled={Boolean(draft.id)}
              onChange={(event) => setDraft({ ...draft, tenantId: event.target.value })}
            />
          </label>
          <label className="text-sm">
            Maximum USD
            <input
              className={inputClass}
              inputMode="decimal"
              value={draft.maximum}
              onChange={(event) => setDraft({ ...draft, maximum: event.target.value })}
            />
          </label>
          <label className="text-sm">
            Per-request hold USD
            <input
              className={inputClass}
              inputMode="decimal"
              value={draft.reservation}
              onChange={(event) => setDraft({ ...draft, reservation: event.target.value })}
            />
          </label>
          <label className="text-sm">
            Window
            <select
              className={inputClass}
              value={draft.duration}
              onChange={(event) =>
                setDraft({ ...draft, duration: event.target.value as RustSharedBudgetDuration })
              }
            >
              <option value="daily">Daily (UTC)</option>
              <option value="monthly">Monthly (UTC)</option>
              <option value="total">Lifetime</option>
            </select>
          </label>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Client keys</legend>
          <p className="text-xs text-text-muted">
            No selection applies the budget to every key in the organization.
          </p>
          <div className="flex flex-wrap gap-3">
            {keys
              .filter((key) => key.tenant_id === draft.tenantId)
              .map((key) => (
                <label key={key.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.keyIds.includes(key.id)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        keyIds: event.target.checked
                          ? [...draft.keyIds, key.id]
                          : draft.keyIds.filter((id) => id !== key.id),
                      })
                    }
                  />
                  {key.label}
                </label>
              ))}
          </div>
        </fieldset>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            Request tags
            <input
              className={inputClass}
              value={draft.tags}
              placeholder="team-a, production"
              onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
            />
            <span className="text-xs text-text-muted">
              Comma-separated; matches metadata.tags or x-red-router-tags.
            </span>
          </label>
          <label className="text-sm">
            End users
            <input
              className={inputClass}
              value={draft.users}
              placeholder="alice, service-account"
              onChange={(event) => setDraft({ ...draft, users: event.target.value })}
            />
            <span className="text-xs text-text-muted">
              Comma-separated; matches body user or x-red-router-end-user.
            </span>
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />
          Enabled
        </label>
        <div className="flex justify-end gap-2">
          {draft.id && (
            <button type="button" onClick={() => setDraft(emptyDraft)}>
              Cancel
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save budget"}
          </button>
        </div>
      </section>

      <section className="overflow-x-auto rounded-xl border border-border bg-surface/50">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="p-3">Budget</th>
              <th className="p-3">Scope</th>
              <th className="p-3">Used + held</th>
              <th className="p-3">Window</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {budgets.map((budget) => (
              <tr key={budget.id} className="border-t border-border">
                <td className="p-3">
                  <strong>{budget.name}</strong>
                  <div className="text-xs text-text-muted">
                    {budget.tenant_id} · {budget.enabled ? "enabled" : "disabled"}
                  </div>
                </td>
                <td className="p-3">
                  {budget.key_ids.length || budget.tags.length || budget.users.length
                    ? [
                        budget.key_ids.length && `${budget.key_ids.length} key(s)`,
                        budget.tags.length && `${budget.tags.length} tag(s)`,
                        budget.users.length && `${budget.users.length} user(s)`,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "All organization keys"}
                </td>
                <td className="p-3">
                  ${budget.spent_usd.toFixed(4)} + ${budget.reserved_usd.toFixed(4)} / $
                  {budget.max_spend_usd.toFixed(2)}
                </td>
                <td className="p-3">
                  {budget.duration}
                  {budget.reset_at_unix_ms
                    ? ` · resets ${new Date(budget.reset_at_unix_ms).toLocaleString()}`
                    : ""}
                </td>
                <td className="p-3">
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setDraft(fromBudget(budget))}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="text-error"
                      disabled={busy}
                      onClick={() => void remove(budget)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {budgets.length === 0 && (
              <tr>
                <td className="p-6 text-text-muted" colSpan={5}>
                  No shared budgets configured.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
