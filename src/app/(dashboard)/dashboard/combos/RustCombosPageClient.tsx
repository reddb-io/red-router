"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card } from "@/shared/components";
import {
  clearRustComboRoutePin,
  disableRustCombo,
  listRustCombos,
  listRustProviderHealth,
  listRustProviderQuotas,
  listRustProviders,
  readRustCatalogProvider,
  replaceRustCombo,
  type RustCatalogProvider,
  type RustCombo,
  type RustComboInput,
  type RustComboProtocol,
  type RustComboStrategy,
  type RustComboTarget,
  type RustProvider,
  type RustProviderHealth,
  type RustProviderQuota,
} from "@/lib/rustControlPlane/browserClient";

type TargetDraft = {
  providerId: string;
  model: string;
  weight: string;
  inputCost: string;
  outputCost: string;
  contextWindow: string;
};

type Draft = {
  id: string;
  protocol: RustComboProtocol;
  strategy: RustComboStrategy;
  fallback: boolean;
  enabled: boolean;
  autoWeights: {
    quota: string;
    cost: string;
    context: string;
    load: string;
  };
  targets: TargetDraft[];
};

const PROTOCOLS: Array<{ value: RustComboProtocol; label: string }> = [
  { value: "openai", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "openai-embeddings", label: "OpenAI Embeddings" },
  { value: "cohere-rerank", label: "Cohere Rerank" },
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "openai-to-anthropic", label: "OpenAI → Anthropic" },
  { value: "openai-to-antigravity", label: "OpenAI → Antigravity" },
  { value: "gemini", label: "Gemini generateContent" },
  { value: "antigravity", label: "Antigravity native" },
];

const STRATEGIES: Array<{ value: RustComboStrategy; label: string }> = [
  { value: "priority", label: "Priority" },
  { value: "auto", label: "Auto balanced" },
  { value: "fill-first", label: "Fill first" },
  { value: "round-robin", label: "Round robin" },
  { value: "weighted", label: "Weighted" },
  { value: "random", label: "Random" },
  { value: "strict-random", label: "Strict random deck" },
  { value: "least-used", label: "Least used" },
  { value: "p2c", label: "Power of two choices" },
  { value: "cost-optimized", label: "Cost optimized" },
  { value: "context-optimized", label: "Context optimized" },
  { value: "cache-optimized", label: "Prompt cache affinity" },
  { value: "reset-aware", label: "Reset aware" },
  { value: "reset-window", label: "Reset window" },
  { value: "headroom", label: "Quota headroom" },
  { value: "quota-weighted", label: "Quota weighted" },
  { value: "lkgp", label: "Last known good" },
];

const EMPTY_TARGET: TargetDraft = {
  providerId: "",
  model: "",
  weight: "",
  inputCost: "",
  outputCost: "",
  contextWindow: "",
};

const EMPTY_DRAFT: Draft = {
  id: "",
  protocol: "openai",
  strategy: "priority",
  fallback: true,
  enabled: true,
  autoWeights: { quota: "0.3", cost: "0.25", context: "0.15", load: "0.3" },
  targets: [{ ...EMPTY_TARGET }],
};

const inputClass =
  "w-full rounded-lg border border-black/10 bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/40 dark:border-white/10";
const labelClass = "flex flex-col gap-1 text-xs font-medium text-text-muted";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Rust combo request failed";
}

function comboDraft(combo: RustCombo): Draft {
  return {
    id: combo.id,
    protocol: combo.protocol,
    strategy: combo.strategy,
    fallback: combo.fallback,
    enabled: combo.enabled,
    autoWeights: {
      quota: String(combo.auto?.weights.quota ?? 0.3),
      cost: String(combo.auto?.weights.cost ?? 0.25),
      context: String(combo.auto?.weights.context ?? 0.15),
      load: String(combo.auto?.weights.load ?? 0.3),
    },
    targets: combo.targets.map((target) => ({
      providerId: target.provider_id,
      model: target.model,
      weight: target.weight === undefined ? "" : String(target.weight),
      inputCost:
        target.input_cost_per_million === undefined ? "" : String(target.input_cost_per_million),
      outputCost:
        target.output_cost_per_million === undefined ? "" : String(target.output_cost_per_million),
      contextWindow:
        target.context_window_tokens === undefined ? "" : String(target.context_window_tokens),
    })),
  };
}

function optionalNumber(value: string, label: string, maximum: number): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${label} must be between 0 and ${maximum.toLocaleString()}`);
  }
  return parsed;
}

function optionalInteger(value: string, label: string, maximum: number): number | undefined {
  const parsed = optionalNumber(value, label, maximum);
  if (parsed !== undefined && (!Number.isSafeInteger(parsed) || parsed < 1)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function requiredNumber(value: string, label: string, maximum: number): number {
  const parsed = optionalNumber(value, label, maximum);
  if (parsed === undefined) throw new Error(`${label} is required`);
  return parsed;
}

function comboInput(draft: Draft, providers: RustProvider[]): RustComboInput {
  const id = draft.id.trim();
  if (!id || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("Combo ID must contain only letters, numbers, dashes or underscores");
  }
  if (draft.targets.length < 1 || draft.targets.length > 8) {
    throw new Error("A combo must contain between one and eight targets");
  }
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const targets: RustComboTarget[] = draft.targets.map((target, index) => {
    const providerId = target.providerId.trim();
    const model = target.model.trim();
    const provider = providerById.get(providerId);
    if (!provider) throw new Error(`Target ${index + 1} must select a configured provider`);
    if (!provider.enabled && draft.enabled) {
      throw new Error(`Target ${index + 1} uses disabled provider ${providerId}`);
    }
    if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/.test(model)) {
      throw new Error(`Target ${index + 1} requires a valid model ID`);
    }
    const weight =
      draft.strategy === "weighted"
        ? optionalInteger(target.weight, `Target ${index + 1} weight`, 100)
        : undefined;
    if (draft.strategy === "weighted" && weight === undefined) {
      throw new Error(`Target ${index + 1} requires a weight`);
    }
    const inputCost = optionalNumber(target.inputCost, `Target ${index + 1} input cost`, 1_000_000);
    const outputCost = optionalNumber(
      target.outputCost,
      `Target ${index + 1} output cost`,
      1_000_000
    );
    const contextWindow = optionalInteger(
      target.contextWindow,
      `Target ${index + 1} context window`,
      10_000_000
    );
    return {
      provider_id: providerId,
      model,
      ...(weight === undefined ? {} : { weight }),
      ...(inputCost === undefined ? {} : { input_cost_per_million: inputCost }),
      ...(outputCost === undefined ? {} : { output_cost_per_million: outputCost }),
      ...(contextWindow === undefined ? {} : { context_window_tokens: contextWindow }),
    };
  });
  const targetKeys = targets.map((target) => `${target.provider_id}\u0000${target.model}`);
  if (new Set(targetKeys).size !== targetKeys.length) {
    throw new Error("A combo cannot contain the same provider and model twice");
  }
  if (
    draft.strategy === "weighted" &&
    targets.reduce((total, target) => total + (target.weight ?? 0), 0) !== 100
  ) {
    throw new Error("Weighted target values must total exactly 100");
  }
  const auto =
    draft.strategy === "auto"
      ? {
          weights: {
            quota: requiredNumber(draft.autoWeights.quota, "Quota weight", 1),
            cost: requiredNumber(draft.autoWeights.cost, "Cost weight", 1),
            context: requiredNumber(draft.autoWeights.context, "Context weight", 1),
            load: requiredNumber(draft.autoWeights.load, "Load weight", 1),
          },
        }
      : undefined;
  if (
    auto &&
    Object.values(auto.weights).reduce((total, weight) => total + weight, 0) <= 0
  ) {
    throw new Error("Auto weights must be between 0 and 1 and contain a positive total");
  }
  return {
    protocol: draft.protocol,
    strategy: draft.strategy,
    fallback: draft.fallback,
    targets,
    ...(auto === undefined ? {} : { auto }),
    enabled: draft.enabled,
  };
}

function quotaSummary(quota?: RustProviderQuota): string | null {
  if (!quota) return null;
  if (quota.limit_reached) return "quota exhausted";
  const values = [quota.session?.remaining_percent, quota.weekly?.remaining_percent].filter(
    (value): value is number => value !== undefined
  );
  if (values.length === 0) return null;
  return `${Math.min(...values).toLocaleString(undefined, { maximumFractionDigits: 1 })}% quota`;
}

function healthSummary(health?: RustProviderHealth): string | null {
  if (!health) return null;
  if (health.terminal_status) return health.terminal_status.replaceAll("_", " ");
  if (health.state !== "closed") return `breaker ${health.state.replaceAll("_", " ")}`;
  if (health.connection_retry_after_ms > 0) return "cooling down";
  if (health.model_lockouts.length > 0) return `${health.model_lockouts.length} model lockout(s)`;
  return "healthy";
}

export default function RustCombosPageClient() {
  const [combos, setCombos] = useState<RustCombo[]>([]);
  const [providers, setProviders] = useState<RustProvider[]>([]);
  const [quotas, setQuotas] = useState<Record<string, RustProviderQuota>>({});
  const [health, setHealth] = useState<Record<string, RustProviderHealth>>({});
  const [catalogs, setCatalogs] = useState<Record<string, RustCatalogProvider>>({});
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers]
  );

  const reload = useCallback(async () => {
    const [comboResult, providerResult, quotaResult, healthResult] = await Promise.allSettled([
      listRustCombos(),
      listRustProviders(),
      listRustProviderQuotas(),
      listRustProviderHealth(),
    ]);
    if (comboResult.status === "rejected") throw comboResult.reason;
    if (providerResult.status === "rejected") throw providerResult.reason;
    setCombos(comboResult.value);
    setProviders(providerResult.value);
    if (quotaResult.status === "fulfilled") {
      setQuotas(Object.fromEntries(quotaResult.value.map((quota) => [quota.provider_id, quota])));
    }
    if (healthResult.status === "fulfilled") {
      setHealth(Object.fromEntries(healthResult.value.map((entry) => [entry.provider_id, entry])));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.resolve();
      await reload();
    })()
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setLoading(false));
  }, [reload]);

  const loadCatalog = useCallback(
    async (providerId: string) => {
      const provider = providerById.get(providerId);
      if (!provider || catalogs[provider.provider]) return;
      try {
        const catalog = await readRustCatalogProvider(provider.provider);
        setCatalogs((current) => ({ ...current, [provider.provider]: catalog }));
      } catch {
        // Custom OpenAI-compatible providers may not have a models.dev namespace.
      }
    },
    [catalogs, providerById]
  );

  const reset = () => {
    setDraft({ ...EMPTY_DRAFT, targets: [{ ...EMPTY_TARGET }] });
    setEditingId(null);
  };

  const edit = (combo: RustCombo) => {
    setEditingId(combo.id);
    setDraft(comboDraft(combo));
    for (const target of combo.targets) void loadCatalog(target.provider_id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const input = comboInput(draft, providers);
      await replaceRustCombo(draft.id.trim(), input);
      reset();
      await reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const disable = async (combo: RustCombo) => {
    if (!window.confirm(`Disable combo “${combo.id}”?`)) return;
    setSaving(true);
    setError(null);
    try {
      await disableRustCombo(combo.id);
      if (editingId === combo.id) reset();
      await reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const clearPin = async (combo: RustCombo) => {
    setSaving(true);
    setError(null);
    try {
      await clearRustComboRoutePin(combo.id);
      await reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const setTarget = (index: number, patch: Partial<TargetDraft>) => {
    setDraft((current) => ({
      ...current,
      targets: current.targets.map((target, targetIndex) =>
        targetIndex === index ? { ...target, ...patch } : target
      ),
    }));
  };

  const moveTarget = (index: number, offset: -1 | 1) => {
    setDraft((current) => {
      const destination = index + offset;
      if (destination < 0 || destination >= current.targets.length) return current;
      const targets = [...current.targets];
      [targets[index], targets[destination]] = [targets[destination], targets[index]];
      return { ...current, targets };
    });
  };

  return (
    <div className="flex flex-col gap-5 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold text-text">Routing combos</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">
          Managed directly by the Rust proxy. Target order, fallback, quota and resilience state are
          applied without a Next.js persistence path.
        </p>
      </div>

      {error && (
        <div
          className="rounded-lg border border-feedback-danger-border bg-feedback-danger-surface p-3 text-sm text-feedback-danger-foreground"
          role="alert"
        >
          {error}
        </div>
      )}

      <Card
        title={editingId ? `Edit ${editingId}` : "Create Rust combo"}
        subtitle="One public model ID can route across up to eight provider connections."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className={labelClass}>
            Combo ID
            <input
              className={inputClass}
              value={draft.id}
              maxLength={128}
              disabled={editingId !== null}
              placeholder="fast-coding"
              onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))}
            />
          </label>
          <label className={labelClass}>
            Client protocol
            <select
              className={inputClass}
              value={draft.protocol}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  protocol: event.target.value as RustComboProtocol,
                }))
              }
            >
              {PROTOCOLS.map((protocol) => (
                <option key={protocol.value} value={protocol.value}>
                  {protocol.label}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Strategy
            <select
              className={inputClass}
              value={draft.strategy}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  strategy: event.target.value as RustComboStrategy,
                  targets: current.targets.map((target) => ({
                    ...target,
                    weight: event.target.value === "weighted" ? target.weight : "",
                  })),
                }))
              }
            >
              {STRATEGIES.map((strategy) => (
                <option key={strategy.value} value={strategy.value}>
                  {strategy.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-col justify-end gap-2">
            <label className="flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={draft.fallback}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, fallback: event.target.checked }))
                }
              />
              Try remaining targets after retryable failure
            </label>
            <label className="flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, enabled: event.target.checked }))
                }
              />
              Enabled after save
            </label>
          </div>
        </div>

        {draft.strategy === "auto" && (
          <div className="mt-4 rounded-lg border border-black/10 p-3 dark:border-white/10">
            <div className="mb-3">
              <strong className="text-sm text-text">Automatic routing weights</strong>
              <p className="text-xs text-text-muted">
                Values are normalized by Rust. Set a signal to zero to ignore it.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(
                [
                  ["quota", "Quota capacity"],
                  ["cost", "Lower cost"],
                  ["context", "Context window"],
                  ["load", "Live concurrency"],
                ] as const
              ).map(([field, label]) => (
                <label className={labelClass} key={field}>
                  {label}
                  <input
                    className={inputClass}
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={draft.autoWeights[field]}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        autoWeights: { ...current.autoWeights, [field]: event.target.value },
                      }))
                    }
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-col gap-3">
          {draft.targets.map((target, index) => {
            const provider = providerById.get(target.providerId);
            const models = provider ? (catalogs[provider.provider]?.models ?? []) : [];
            return (
              <div
                key={`${index}-${target.providerId}`}
                className="rounded-lg border border-black/10 p-3 dark:border-white/10"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <strong className="text-sm text-text">Target {index + 1}</strong>
                  <div className="flex gap-1">
                    <Button
                      variant="secondary"
                      disabled={index === 0}
                      onClick={() => moveTarget(index, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={index === draft.targets.length - 1}
                      onClick={() => moveTarget(index, 1)}
                    >
                      ↓
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={draft.targets.length === 1}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          targets: current.targets.filter(
                            (_, targetIndex) => targetIndex !== index
                          ),
                        }))
                      }
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <label className={labelClass}>
                    Provider connection
                    <select
                      className={inputClass}
                      value={target.providerId}
                      onChange={(event) => {
                        setTarget(index, { providerId: event.target.value, model: "" });
                        void loadCatalog(event.target.value);
                      }}
                    >
                      <option value="">Select provider</option>
                      {providers.map((candidate) => (
                        <option
                          key={candidate.id}
                          value={candidate.id}
                          disabled={!candidate.enabled && candidate.id !== target.providerId}
                        >
                          {candidate.label} · {candidate.id}
                          {candidate.enabled ? "" : " · disabled"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={labelClass}>
                    Exact provider model ID
                    <input
                      className={inputClass}
                      list={`rust-combo-models-${index}`}
                      value={target.model}
                      maxLength={256}
                      placeholder="gpt-5.3-codex"
                      onFocus={() => void loadCatalog(target.providerId)}
                      onChange={(event) => setTarget(index, { model: event.target.value })}
                    />
                    <datalist id={`rust-combo-models-${index}`}>
                      {models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name ?? model.id}
                        </option>
                      ))}
                    </datalist>
                  </label>
                  {draft.strategy === "weighted" && (
                    <label className={labelClass}>
                      Weight (all targets total 100)
                      <input
                        className={inputClass}
                        type="number"
                        min={1}
                        max={100}
                        step={1}
                        value={target.weight}
                        onChange={(event) => setTarget(index, { weight: event.target.value })}
                      />
                    </label>
                  )}
                  {(draft.strategy === "cost-optimized" || draft.strategy === "auto") && (
                    <>
                      <label className={labelClass}>
                        Input USD / million
                        <input
                          className={inputClass}
                          type="number"
                          min={0}
                          step="any"
                          value={target.inputCost}
                          placeholder="models.dev when blank"
                          onChange={(event) => setTarget(index, { inputCost: event.target.value })}
                        />
                      </label>
                      <label className={labelClass}>
                        Output USD / million
                        <input
                          className={inputClass}
                          type="number"
                          min={0}
                          step="any"
                          value={target.outputCost}
                          placeholder="models.dev when blank"
                          onChange={(event) => setTarget(index, { outputCost: event.target.value })}
                        />
                      </label>
                    </>
                  )}
                  {(draft.strategy === "context-optimized" || draft.strategy === "auto") && (
                    <label className={labelClass}>
                      Context window tokens
                      <input
                        className={inputClass}
                        type="number"
                        min={1}
                        max={10000000}
                        step={1}
                        value={target.contextWindow}
                        placeholder="models.dev when blank"
                        onChange={(event) =>
                          setTarget(index, { contextWindow: event.target.value })
                        }
                      />
                    </label>
                  )}
                </div>
                {provider && (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-text-muted">
                    <span>{provider.provider}</span>
                    {quotaSummary(quotas[provider.id]) && (
                      <span>· {quotaSummary(quotas[provider.id])}</span>
                    )}
                    {healthSummary(health[provider.id]) && (
                      <span>· {healthSummary(health[provider.id])}</span>
                    )}
                    {models.length > 0 && <span>· {models.length} catalog models</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={draft.targets.length >= 8}
            onClick={() =>
              setDraft((current) => ({
                ...current,
                targets: [...current.targets, { ...EMPTY_TARGET }],
              }))
            }
          >
            Add target
          </Button>
          <Button loading={saving} onClick={() => void save()}>
            {editingId ? "Save combo" : "Create combo"}
          </Button>
          {editingId && (
            <Button variant="secondary" onClick={reset}>
              Cancel edit
            </Button>
          )}
        </div>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-text">Rust-owned routes</h2>
        <span className="text-xs text-text-muted">{combos.length} configured</span>
      </div>

      {loading ? (
        <Card>
          <p className="text-sm text-text-muted" role="status">
            Loading Rust combos…
          </p>
        </Card>
      ) : combos.length === 0 ? (
        <Card>
          <p className="text-sm text-text-muted">No Rust combos configured yet.</p>
        </Card>
      ) : (
        combos.map((combo) => (
          <Card
            key={combo.id}
            title={combo.id}
            subtitle={`${combo.protocol} · ${STRATEGIES.find((entry) => entry.value === combo.strategy)?.label ?? combo.strategy} · tenant ${combo.tenant_id}`}
            action={
              <span
                className={`rounded-full px-2 py-1 text-xs ${
                  combo.enabled
                    ? "bg-feedback-success-surface text-feedback-success-foreground"
                    : "bg-black/5 text-text-muted dark:bg-white/5"
                }`}
              >
                {combo.enabled ? "Enabled" : "Disabled"}
              </span>
            }
          >
            <div className="grid gap-2">
              {combo.targets.map((target, index) => {
                const provider = providerById.get(target.provider_id);
                return (
                  <div
                    key={`${target.provider_id}-${target.model}`}
                    className="rounded-lg border border-black/10 px-3 py-2 text-sm dark:border-white/10"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-text">
                        {index + 1}. {target.provider_id} / {target.model}
                      </span>
                      <div className="flex flex-wrap gap-2 text-xs text-text-muted">
                        {target.weight !== undefined && <span>weight {target.weight}</span>}
                        {quotaSummary(quotas[target.provider_id]) && (
                          <span>{quotaSummary(quotas[target.provider_id])}</span>
                        )}
                        {healthSummary(health[target.provider_id]) && (
                          <span>{healthSummary(health[target.provider_id])}</span>
                        )}
                      </div>
                    </div>
                    {provider && (
                      <div className="mt-1 text-xs text-text-muted">{provider.label}</div>
                    )}
                  </div>
                );
              })}
            </div>
            {combo.auto && (
              <div className="mt-3 rounded-lg bg-black/[0.03] p-3 text-xs text-text-muted dark:bg-white/[0.04]">
                Auto weights: quota {combo.auto.weights.quota}, cost {combo.auto.weights.cost},
                context {combo.auto.weights.context}, load {combo.auto.weights.load}
              </div>
            )}
            {combo.last_known_good && (
              <div className="mt-3 rounded-lg bg-black/[0.03] p-3 text-xs text-text-muted dark:bg-white/[0.04]">
                Last known good: {combo.last_known_good.provider_id} / {combo.last_known_good.model}
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="secondary" disabled={saving} onClick={() => edit(combo)}>
                Edit
              </Button>
              {combo.last_known_good && (
                <Button variant="secondary" disabled={saving} onClick={() => void clearPin(combo)}>
                  Clear last-known-good
                </Button>
              )}
              {combo.enabled && (
                <Button variant="secondary" disabled={saving} onClick={() => void disable(combo)}>
                  Disable
                </Button>
              )}
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
