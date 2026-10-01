"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, Badge, Toggle, Select, SegmentedControl } from "@/shared/components";
import { useTranslations } from "next-intl";

interface VerificationConnectionOption {
  id: string;
  name: string;
  provider: string;
  models: { id: string; name: string }[];
}
interface VerificationStats {
  since: string;
  accepted: number;
  rejected: number;
  unavailable: number;
  skipped: number;
  averageLatencyMs: number;
  knownEvaluationCostUsd: number;
  unpricedEvaluations: number;
  avoidedCostEstimateUsd: number;
}
type ReusePolicy = "off" | "exact" | "similar" | "verified";
type Message = { type: "success" | "error"; text: string };

interface AvailableEmbeddingModelOption {
  id: string;
  rawId: string;
  name: string;
  dimensions?: number;
  maxTokens?: number;
  supportedInputTypes: string[];
}

interface EmbeddingProviderOption {
  id: string;
  name: string;
  hasConnection: boolean;
  baseUrl?: string;
  models: AvailableEmbeddingModelOption[];
}

interface CacheConfigResponse {
  modelCatalogCacheTtlMs: number;
  semanticCacheEnabled?: boolean;
  semanticCacheMaxSize?: number;
  semanticCacheTTL?: number;
  semanticCacheVectorEnabled?: boolean;
  semanticCacheBackend?: "memory" | "redis";
  semanticCacheThreshold?: number;
  semanticCacheEmbeddingProvider?: string;
  semanticCacheEmbeddingModel?: string;
  semanticCacheEmbeddingDimension?: number;
  semanticCacheEmbeddingBaseUrl?: string;
  semanticCacheEmbeddingApiKey?: string;
  semanticCacheRedisUrl?: string;
  semanticCacheRedisPrefix?: string;
  semanticCacheRequireZeroTemp?: boolean;
  embeddingOptions?: EmbeddingProviderOption[];
  semanticCacheVerificationEnabled?: boolean;
  semanticCacheVerificationConnectionId?: string;
  semanticCacheVerificationModel?: string;
  semanticCacheVerificationMinProbability?: number;
  semanticCacheVerificationTimeoutMs?: number;
  verificationOptions?: VerificationConnectionOption[];
  verificationStats?: VerificationStats;
  [key: string]: unknown;
}

const DEFAULT_TTL_MS = 1500;
const MIN_TTL_MS = 100;
const MAX_TTL_MS = 60000;

export default function CacheSettingsTab() {
  const t = useTranslations("settings");

  // Model Catalog Cache State
  const [catalogTtl, setCatalogTtl] = useState(String(DEFAULT_TTL_MS));
  const [savedCatalogTtl, setSavedCatalogTtl] = useState(String(DEFAULT_TTL_MS));
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogSaving, setCatalogSaving] = useState(false);
  const [catalogMessage, setCatalogMessage] = useState<Message | null>(null);

  // Semantic Cache State
  const [semEnabled, setSemEnabled] = useState(true);
  // Vector-similarity layer is opt-in (#14159): off unless the operator turns it on.
  const [semVectorEnabled, setSemVectorEnabled] = useState(false);
  const [semBackend, setSemBackend] = useState<"memory" | "redis">("memory");
  const [semThreshold, setSemThreshold] = useState(0.8);
  const [semTtlMinutes, setSemTtlMinutes] = useState(30);
  const [semMaxSize, setSemMaxSize] = useState(1000);
  const [semProvider, setSemProvider] = useState("lemonade");
  const [semModel, setSemModel] = useState("harrier-oss-v1-0.6b");
  const [semDimension, setSemDimension] = useState<number | undefined>(1024);
  const [semBaseUrl, setSemBaseUrl] = useState("");
  const [semApiKey, setSemApiKey] = useState("");
  const [semRedisUrl, setSemRedisUrl] = useState("");
  const [semRedisPrefix, setSemRedisPrefix] = useState("omniroute:semcache:");
  const [semRequireZeroTemp, setSemRequireZeroTemp] = useState(true);

  const [verificationEnabled, setVerificationEnabled] = useState(false);
  const [verificationConnection, setVerificationConnection] = useState("");
  const [verificationModel, setVerificationModel] = useState("");
  const [verificationProbability, setVerificationProbability] = useState(0.95);
  const [verificationTimeout, setVerificationTimeout] = useState(1500);
  const [verificationOptions, setVerificationOptions] = useState<VerificationConnectionOption[]>(
    []
  );
  const [verificationStats, setVerificationStats] = useState<VerificationStats | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState(false);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState(false);
  const verificationTuningValid =
    Number.isFinite(verificationProbability) &&
    verificationProbability >= 0.8 &&
    verificationProbability <= 1 &&
    Number.isInteger(verificationTimeout) &&
    verificationTimeout >= 100 &&
    verificationTimeout <= 5000;
  const reloadVerificationOptions = async () => {
    setOptionsLoading(true);
    setOptionsError(false);
    try {
      const response = await fetch("/api/settings/cache-config");
      if (!response.ok) throw new Error("Connections unavailable");
      const config = (await response.json()) as CacheConfigResponse;
      setVerificationOptions(config.verificationOptions ?? []);
    } catch {
      setOptionsError(true);
    } finally {
      setOptionsLoading(false);
    }
  };
  const reusePolicy: ReusePolicy = !semEnabled
    ? "off"
    : !semVectorEnabled
      ? "exact"
      : verificationEnabled
        ? "verified"
        : "similar";
  const selectedVerificationConnection = verificationOptions.find(
    (item) => item.id === verificationConnection
  );
  const verificationReady = selectedVerificationConnection?.models.some(
    (item) => item.id === verificationModel
  );
  const chooseReusePolicy = (policy: ReusePolicy) => {
    setSemEnabled(policy !== "off");
    setSemVectorEnabled(policy === "similar" || policy === "verified");
    setVerificationEnabled(policy === "verified");
    setSemMessage(null);
  };
  const refreshVerificationStats = async () => {
    setStatsLoading(true);
    setStatsError(false);
    try {
      const response = await fetch("/api/cache/stats");
      if (!response.ok) throw new Error("Stats unavailable");
      const data = await response.json();
      setVerificationStats(data.verification ?? null);
    } catch {
      setStatsError(true);
    } finally {
      setStatsLoading(false);
    }
  };

  // Saved Semantic Cache State
  const [semSaving, setSemSaving] = useState(false);
  const [semMessage, setSemMessage] = useState<Message | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Dynamic Options
  const [embeddingOptions, setEmbeddingOptions] = useState<EmbeddingProviderOption[]>([]);

  // Test Connection State
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    latencyMs?: number;
    dimensions?: number;
    resolvedBaseUrl?: string;
    error?: string;
  } | null>(null);

  // Clear Cache State
  const [clearingCache, setClearingCache] = useState(false);
  const [clearMessage, setClearMessage] = useState<string | null>(null);

  // Load Cache Config and Dynamic Options in a single request
  useEffect(() => {
    let active = true;
    setCatalogLoading(true);
    setConfigLoaded(false);

    fetch("/api/settings/cache-config")
      .then((response) => {
        if (!response.ok) throw new Error(`Cache config API returned ${response.status}`);
        return response.json() as Promise<CacheConfigResponse>;
      })
      .then((config) => {
        if (!active) return;
        setConfigLoaded(true);
        setCatalogMessage(null);
        setVerificationEnabled(config.semanticCacheVerificationEnabled === true);
        setVerificationConnection(config.semanticCacheVerificationConnectionId ?? "");
        setVerificationModel(config.semanticCacheVerificationModel ?? "");
        setVerificationProbability(config.semanticCacheVerificationMinProbability ?? 0.95);
        setVerificationTimeout(config.semanticCacheVerificationTimeoutMs ?? 1500);
        setVerificationOptions(config.verificationOptions ?? []);
        setVerificationStats(config.verificationStats ?? null);
        const ms = config.modelCatalogCacheTtlMs ?? DEFAULT_TTL_MS;
        const str =
          typeof ms === "number" && Number.isFinite(ms) ? String(ms) : String(DEFAULT_TTL_MS);
        setCatalogTtl(str);
        setSavedCatalogTtl(str);

        if (config.semanticCacheEnabled !== undefined) {
          setSemEnabled(config.semanticCacheEnabled);
        }
        if (config.semanticCacheVectorEnabled !== undefined) {
          setSemVectorEnabled(config.semanticCacheVectorEnabled);
        }
        if (config.semanticCacheBackend === "redis" || config.semanticCacheBackend === "memory") {
          setSemBackend(config.semanticCacheBackend);
        }
        if (typeof config.semanticCacheThreshold === "number") {
          setSemThreshold(config.semanticCacheThreshold);
        }
        if (typeof config.semanticCacheTTL === "number") {
          setSemTtlMinutes(Math.round(config.semanticCacheTTL / 60000));
        }
        if (typeof config.semanticCacheMaxSize === "number") {
          setSemMaxSize(config.semanticCacheMaxSize);
        }
        if (config.semanticCacheEmbeddingProvider) {
          setSemProvider(config.semanticCacheEmbeddingProvider);
        }
        if (config.semanticCacheEmbeddingModel) {
          setSemModel(config.semanticCacheEmbeddingModel);
        }
        if (typeof config.semanticCacheEmbeddingDimension === "number") {
          setSemDimension(config.semanticCacheEmbeddingDimension);
        }
        if (typeof config.semanticCacheEmbeddingBaseUrl === "string") {
          setSemBaseUrl(config.semanticCacheEmbeddingBaseUrl);
        }
        if (typeof config.semanticCacheEmbeddingApiKey === "string") {
          setSemApiKey(config.semanticCacheEmbeddingApiKey);
        }
        if (typeof config.semanticCacheRedisUrl === "string") {
          setSemRedisUrl(config.semanticCacheRedisUrl);
        }
        if (typeof config.semanticCacheRedisPrefix === "string") {
          setSemRedisPrefix(config.semanticCacheRedisPrefix);
        }
        if (config.semanticCacheRequireZeroTemp !== undefined) {
          setSemRequireZeroTemp(config.semanticCacheRequireZeroTemp);
        }
        if (Array.isArray(config.embeddingOptions)) {
          setEmbeddingOptions(config.embeddingOptions);
        }
      })
      .catch((error) => {
        console.error("Failed to load cache config:", error);
        if (active) setCatalogMessage({ type: "error", text: t("cacheConfigLoadFailed") });
      })
      .finally(() => {
        if (active) setCatalogLoading(false);
      });

    return () => {
      active = false;
    };
  }, [t, loadAttempt]);

  // Catalog TTL validation and save
  const catalogDirty = catalogTtl.trim() !== savedCatalogTtl;

  const saveCatalogTtl = useCallback(async () => {
    if (!catalogDirty || !configLoaded) return;

    const parsed = Number(catalogTtl.trim());
    if (!Number.isInteger(parsed)) return;
    if (parsed < MIN_TTL_MS || parsed > MAX_TTL_MS) return;

    setCatalogSaving(true);
    setCatalogMessage(null);

    try {
      const response = await fetch("/api/settings/cache-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelCatalogCacheTtlMs: parsed }),
      });

      if (!response.ok) throw new Error(`Cache config API returned ${response.status}`);

      const config = (await response.json()) as CacheConfigResponse;
      const saved = String(config.modelCatalogCacheTtlMs ?? parsed);
      setCatalogTtl(saved);
      setSavedCatalogTtl(saved);
      setCatalogMessage({ type: "success", text: t("cacheConfigSaveSuccess") });
    } catch (error) {
      console.error("Failed to save cache config:", error);
      setCatalogMessage({ type: "error", text: t("cacheConfigSaveFailed") });
    } finally {
      setCatalogSaving(false);
    }
  }, [catalogDirty, t, catalogTtl, configLoaded]);

  const catalogValidationError = (() => {
    const trimmed = catalogTtl.trim();
    if (!trimmed) return "Required";
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed)) return t("modelCatalogTtlWholeNumberError");
    if (parsed < MIN_TTL_MS) return t("modelCatalogTtlMinimumError", { min: MIN_TTL_MS });
    if (parsed > MAX_TTL_MS) return t("modelCatalogTtlMaximumError", { max: MAX_TTL_MS });
    return null;
  })();

  // Current selected provider and model details
  const selectedProviderOption = embeddingOptions.find((p) => p.id === semProvider);
  const availableModelsForProvider = selectedProviderOption?.models || [];
  const selectedModelOption = availableModelsForProvider.find(
    (m) => m.rawId === semModel || m.id === semModel
  );

  // Sync dimensions when model selection changes
  const handleModelChange = (modelIdOrRaw: string) => {
    setSemModel(modelIdOrRaw);
    const m = availableModelsForProvider.find(
      (item) => item.rawId === modelIdOrRaw || item.id === modelIdOrRaw
    );
    if (m?.dimensions) {
      setSemDimension(m.dimensions);
    }
    setTestResult(null);
  };

  const handleProviderChange = (newProvider: string) => {
    setSemProvider(newProvider);
    const provider = embeddingOptions.find((p) => p.id === newProvider);
    if (provider && provider.models.length > 0) {
      const firstModel = provider.models[0];
      setSemModel(firstModel.rawId || firstModel.id);
      if (firstModel.dimensions) {
        setSemDimension(firstModel.dimensions);
      }
    }
    setTestResult(null);
  };

  // Save Semantic Cache Config
  const saveSemanticCache = async () => {
    if (
      !configLoaded ||
      (reusePolicy === "verified" && (!verificationReady || !verificationTuningValid))
    )
      return;
    setSemSaving(true);
    setSemMessage(null);

    const payload = {
      semanticCacheEnabled: semEnabled,
      semanticCacheVectorEnabled: semVectorEnabled,
      semanticCacheVerificationEnabled: verificationEnabled,
      semanticCacheVerificationConnectionId: verificationConnection,
      semanticCacheVerificationModel: verificationModel,
      ...(reusePolicy === "verified"
        ? {
            semanticCacheVerificationMinProbability: verificationProbability,
            semanticCacheVerificationTimeoutMs: verificationTimeout,
          }
        : {}),
      semanticCacheBackend: semBackend,
      semanticCacheThreshold: Number(semThreshold),
      semanticCacheTTL: semTtlMinutes * 60000,
      semanticCacheMaxSize: Number(semMaxSize),
      semanticCacheEmbeddingProvider: semProvider,
      semanticCacheEmbeddingModel: semModel,
      semanticCacheEmbeddingDimension: semDimension ? Number(semDimension) : null,
      semanticCacheEmbeddingBaseUrl: semBaseUrl.trim() || selectedProviderOption?.baseUrl || null,
      semanticCacheEmbeddingApiKey: semApiKey.trim() || null,
      semanticCacheRedisUrl: semRedisUrl.trim() || null,
      semanticCacheRedisPrefix: semRedisPrefix.trim() || "omniroute:semcache:",
      semanticCacheRequireZeroTemp: semRequireZeroTemp,
    };

    try {
      const res = await fetch("/api/settings/cache-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSemMessage({
          type: "error",
          text:
            typeof data.error === "string" ? data.error : "Could not save response reuse settings.",
        });
        return;
      }

      setSemMessage({ type: "success", text: "Response reuse settings saved." });
    } catch (err) {
      console.error("Failed to save semantic cache settings:", err);
      setSemMessage({ type: "error", text: "Could not save response reuse settings." });
    } finally {
      setSemSaving(false);
    }
  };

  // Test embedding connection
  const handleTestConnection = async () => {
    setTestingConnection(true);
    setTestResult(null);

    try {
      const res = await fetch("/api/settings/cache-config/test-embedding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: semProvider,
          model: semModel,
          baseUrl: semBaseUrl.trim() || selectedProviderOption?.baseUrl || undefined,
          apiKey: semApiKey.trim() || undefined,
          dimensions: semDimension,
        }),
      });

      const data = await res.json();
      setTestResult(data);
    } catch (err: unknown) {
      setTestResult({ ok: false, error: String(err) });
    } finally {
      setTestingConnection(false);
    }
  };

  // Clear cache
  const handleClearCache = async () => {
    setClearingCache(true);
    setClearMessage(null);

    try {
      const res = await fetch("/api/cache", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to clear cache");
      setClearMessage("Semantic cache purged successfully.");
    } catch (err: unknown) {
      setClearMessage(`Failed to purge cache: ${String(err)}`);
    } finally {
      setClearingCache(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 mt-4">
      {/* ── 1. Semantic Caching Card ── */}
      <Card className="p-6">
        <div className="flex flex-col gap-5">
          {/* Card Header & Master Toggle */}
          <div className="flex items-center justify-between pb-4 border-b border-border/50">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-base text-text-primary">Response reuse</h3>
                <Badge variant={semEnabled ? "success" : "default"} size="sm">
                  {semEnabled ? "Active" : "Disabled"}
                </Badge>
              </div>
              <p className="text-sm text-text-muted mt-1">
                Choose when a saved answer can serve a request. Identical requests skip generation;
                verified reuse also checks whether a similar answer satisfies the new request.
              </p>
            </div>
          </div>
          <Select
            id="response-reuse-policy"
            label="Reuse responses for"
            value={reusePolicy}
            disabled={catalogLoading || !configLoaded || semSaving}
            onChange={(event) => chooseReusePolicy(event.target.value as ReusePolicy)}
            options={[
              { value: "off", label: "Off" },
              { value: "exact", label: "Identical requests" },
              { value: "similar", label: "Similar requests" },
              { value: "verified", label: "Similar requests, verified by a decision model" },
            ]}
            hint={
              reusePolicy === "off"
                ? "Every request goes to its selected model."
                : reusePolicy === "exact"
                  ? "No embedding or decision calls. This is the default."
                  : reusePolicy === "similar"
                    ? "Similarity alone decides reuse. Embedding calls may incur costs."
                    : "Identical requests stay direct. Similar candidates require compatible context and an accepted decision. Embedding and decision calls may incur costs."
            }
          />
          {!catalogLoading && !configLoaded && (
            <div role="alert" className="text-sm text-red-600">
              Cache settings could not be loaded. Your saved configuration has not changed.
              <Button
                size="sm"
                variant="outline"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              >
                Retry loading settings
              </Button>
            </div>
          )}
          {reusePolicy === "verified" && (
            <div className="flex flex-col gap-3 pt-2">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Select
                  id="cache-verification-connection"
                  label="Verification connection"
                  value={verificationConnection}
                  disabled={catalogLoading || semSaving}
                  placeholder="Choose a connection"
                  options={[
                    ...(verificationConnection && !selectedVerificationConnection
                      ? [{ value: verificationConnection, label: "Saved connection unavailable" }]
                      : []),
                    ...verificationOptions.map((item) => ({
                      value: item.id,
                      label: `${item.name} (${item.provider})`,
                    })),
                  ]}
                  onChange={(event) => {
                    setVerificationConnection(event.target.value);
                    setVerificationModel("");
                  }}
                  hint="Uses the caller's allowed connections, quota and budget."
                />
                <Select
                  id="cache-verification-model"
                  label="Decision model"
                  value={verificationModel}
                  placeholder="Choose a decision model"
                  disabled={catalogLoading || semSaving || !selectedVerificationConnection}
                  options={[
                    ...(verificationModel && !verificationReady
                      ? [{ value: verificationModel, label: `${verificationModel} (unavailable)` }]
                      : []),
                    ...(selectedVerificationConnection?.models.map((item) => ({
                      value: item.id,
                      label: item.name,
                    })) ?? []),
                  ]}
                  onChange={(event) => setVerificationModel(event.target.value)}
                />
              </div>
              {!verificationReady && !catalogLoading && (
                <p role="status" className="text-sm text-text-muted">
                  {verificationOptions.length
                    ? "Choose an active connection and its decision model before saving."
                    : "Add a connection with a System One decision model in Providers, then reload these settings."}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={reloadVerificationOptions}
                    disabled={optionsLoading}
                  >
                    {optionsLoading ? "Reloading..." : "Reload connections"}
                  </Button>
                </p>
              )}
              {optionsError && (
                <p role="alert" className="text-xs text-red-600">
                  Connections could not be reloaded. Your choices have been kept.
                </p>
              )}
              <p className="text-xs text-text-muted">
                Rejected, unavailable or inconclusive decisions use normal generation. Tools,
                images, changed instructions and incompatible output settings bypass verified reuse.
                Verification sends the question, context and cached answer to the selected
                connection.
              </p>
            </div>
          )}
          {semEnabled && (
            <div className="flex flex-col gap-5">
              {semVectorEnabled && (
                <>
                  {/* Provider & Model Selection Row */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <Select
                        id="cache-embedding-provider"
                        label="Embedding provider"
                        value={semProvider}
                        onChange={(e) => handleProviderChange(e.target.value)}
                        disabled={catalogLoading || semSaving}
                        options={
                          embeddingOptions.length > 0
                            ? embeddingOptions.map((opt) => ({
                                value: opt.id,
                                label: opt.hasConnection ? `${opt.name} (Configured)` : opt.name,
                              }))
                            : [{ value: semProvider, label: semProvider }]
                        }
                      />
                      {selectedProviderOption && (
                        <p className="text-xs text-text-muted mt-1">
                          {selectedProviderOption.hasConnection
                            ? `Using configured connection (${selectedProviderOption.baseUrl || "Default URL"})`
                            : "Requires provider connection or API key"}
                        </p>
                      )}
                    </div>

                    <div>
                      <Select
                        id="cache-embedding-model"
                        label="Embedding model"
                        value={semModel}
                        onChange={(e) => handleModelChange(e.target.value)}
                        disabled={
                          catalogLoading || semSaving || availableModelsForProvider.length === 0
                        }
                        options={
                          availableModelsForProvider.length > 0
                            ? availableModelsForProvider.map((m) => ({
                                value: m.rawId || m.id,
                                label: m.dimensions
                                  ? `${m.name || m.rawId} (${m.dimensions} dims)`
                                  : m.name || m.rawId,
                              }))
                            : [{ value: semModel, label: semModel }]
                        }
                      />

                      {/* Model Metadata Badges */}
                      <div className="flex flex-wrap gap-2 mt-2">
                        {semDimension ? (
                          <Badge variant="primary" size="sm">
                            {semDimension} Dimensions
                          </Badge>
                        ) : null}
                        {selectedModelOption?.maxTokens ? (
                          <Badge variant="info" size="sm">
                            {selectedModelOption.maxTokens.toLocaleString()} Max Tokens
                          </Badge>
                        ) : null}
                        {selectedModelOption?.supportedInputTypes ? (
                          <Badge variant="default" size="sm">
                            Input: {selectedModelOption.supportedInputTypes.join(", ")}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </>
              )}
              {/* Threshold Slider & TTL */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                {semVectorEnabled && (
                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <label
                        htmlFor="cache-similarity-threshold"
                        className="text-sm font-medium text-text-primary"
                      >
                        Similarity Threshold
                      </label>
                      <span className="text-xs font-mono font-bold text-primary">
                        {semThreshold.toFixed(2)}
                      </span>
                    </div>
                    <input
                      id="cache-similarity-threshold"
                      type="range"
                      min="0.50"
                      max="1.00"
                      step="0.01"
                      value={semThreshold}
                      onChange={(e) => setSemThreshold(parseFloat(e.target.value))}
                      className="w-full h-2 bg-surface-2 rounded-lg appearance-none cursor-pointer accent-primary"
                      disabled={semSaving}
                    />
                    <p className="text-xs text-text-muted mt-1">
                      Higher values narrow the candidates. Verified reuse still requires a separate
                      decision.
                    </p>
                  </div>
                )}

                <div>
                  <label
                    htmlFor="cache-retention"
                    className="block text-sm font-medium text-text-primary mb-1"
                  >
                    Cache Retention (TTL)
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={10080}
                      id="cache-retention"
                      value={semTtlMinutes}
                      onChange={(e) => setSemTtlMinutes(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-28 px-3 py-1.5 rounded bg-surface-2 border border-border text-sm text-text-primary"
                      disabled={semSaving}
                    />
                    <span className="text-xs text-text-muted">minutes</span>
                  </div>
                  <p className="text-xs text-text-muted mt-1">
                    Default 30 minutes. Entries expire after this duration.
                  </p>
                </div>
              </div>

              {semVectorEnabled && (
                <>
                  {/* Storage Backend Selection */}
                  <div className="pt-2 border-t border-border/40">
                    <label className="block text-sm font-medium text-text-primary mb-2">
                      Storage Engine
                    </label>
                    <SegmentedControl
                      value={semBackend}
                      onChange={(val) => setSemBackend(val as "memory" | "redis")}
                      options={[
                        { value: "memory", label: "In-Memory Vector (LRU)" },
                        { value: "redis", label: "Redis Vector Store" },
                      ]}
                    />

                    {semBackend === "memory" ? (
                      <div className="mt-3">
                        <label className="block text-xs font-medium text-text-muted mb-1">
                          Max In-Memory Entries
                        </label>
                        <input
                          type="number"
                          min={10}
                          max={100000}
                          value={semMaxSize}
                          onChange={(e) => setSemMaxSize(parseInt(e.target.value) || 100)}
                          className="w-32 px-3 py-1.5 rounded bg-surface-2 border border-border text-sm text-text-primary"
                          disabled={semSaving}
                        />
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                        <div>
                          <label className="block text-xs font-medium text-text-muted mb-1">
                            Redis URL
                          </label>
                          <input
                            type="text"
                            placeholder="redis://127.0.0.1:6379"
                            value={semRedisUrl}
                            onChange={(e) => setSemRedisUrl(e.target.value)}
                            className="w-full px-3 py-1.5 rounded bg-surface-2 border border-border text-sm text-text-primary"
                            disabled={semSaving}
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-text-muted mb-1">
                            Redis Key Prefix
                          </label>
                          <input
                            type="text"
                            value={semRedisPrefix}
                            onChange={(e) => setSemRedisPrefix(e.target.value)}
                            className="w-full px-3 py-1.5 rounded bg-surface-2 border border-border text-sm text-text-primary"
                            disabled={semSaving}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Determinism Toggle */}
                  <div className="flex items-center justify-between pt-2 border-t border-border/40">
                    <div>
                      <p className="text-sm font-medium text-text-primary">
                        Require Strict Determinism (temperature = 0)
                      </p>
                      <p className="text-xs text-text-muted">
                        Only cache and serve responses when temperature is 0, avoiding stochastic
                        variance.
                      </p>
                    </div>
                    <Toggle
                      checked={semRequireZeroTemp}
                      onChange={setSemRequireZeroTemp}
                      ariaLabel="Require zero temperature"
                    />
                  </div>

                  {reusePolicy === "verified" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="cache-review-probability" className="block text-sm mb-1">
                          Minimum acceptance probability
                        </label>
                        <input
                          id="cache-review-probability"
                          type="number"
                          min={0.8}
                          max={1}
                          step={0.01}
                          value={verificationProbability}
                          onChange={(event) =>
                            setVerificationProbability(Number(event.target.value))
                          }
                          className="w-28 px-3 py-1.5 rounded bg-surface-2 border border-border text-sm"
                        />
                      </div>
                      <div>
                        <label htmlFor="cache-review-deadline" className="block text-sm mb-1">
                          Verification deadline (ms)
                        </label>
                        <input
                          id="cache-review-deadline"
                          type="number"
                          min={100}
                          max={5000}
                          step={100}
                          value={verificationTimeout}
                          onChange={(event) => setVerificationTimeout(Number(event.target.value))}
                          className="w-28 px-3 py-1.5 rounded bg-surface-2 border border-border text-sm"
                        />
                      </div>
                    </div>
                  )}
                  {reusePolicy === "verified" && !verificationTuningValid && (
                    <p role="alert" className="text-xs text-red-600">
                      Use a probability from 0.80 to 1.00 and a deadline from 100 to 5000 ms.
                    </p>
                  )}
                  {/* Advanced Overrides Accordion */}
                  <div className="pt-2 border-t border-border/40">
                    <button
                      type="button"
                      onClick={() => setShowAdvanced(!showAdvanced)}
                      className="text-xs font-medium text-primary hover:underline flex items-center gap-1"
                    >
                      {showAdvanced
                        ? "▼ Hide Advanced Endpoint Overrides"
                        : "▶ Show Advanced Endpoint Overrides"}
                    </button>

                    {showAdvanced && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3 p-3 rounded-lg bg-surface-2/40 border border-border/40">
                        <div>
                          <label className="block text-xs font-medium text-text-muted mb-1">
                            Custom Embedding Base URL
                          </label>
                          <input
                            type="text"
                            placeholder="https://custom-embedding.internal/v1"
                            value={semBaseUrl}
                            onChange={(e) => setSemBaseUrl(e.target.value)}
                            className="w-full px-3 py-1.5 rounded bg-surface-2 border border-border text-xs text-text-primary"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-text-muted mb-1">
                            Custom Embedding API Key
                          </label>
                          <input
                            type="password"
                            placeholder="Bearer token or API key"
                            value={semApiKey}
                            onChange={(e) => setSemApiKey(e.target.value)}
                            className="w-full px-3 py-1.5 rounded bg-surface-2 border border-border text-xs text-text-primary"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
          {verificationStats && (
            <div className="pt-3 border-t border-border/50">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">Reuse verification activity</p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={refreshVerificationStats}
                  disabled={statsLoading}
                >
                  {statsLoading ? "Refreshing..." : "Refresh activity"}
                </Button>
              </div>
              <p className="text-xs text-text-muted">
                Since server start ({new Date(verificationStats.since).toLocaleString()}). Clearing
                cached answers keeps these counters.
              </p>
              <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-sm">
                <div>
                  <dt className="text-text-muted">Accepted</dt>
                  <dd>{verificationStats.accepted}</dd>
                </div>
                <div>
                  <dt className="text-text-muted">Rejected</dt>
                  <dd>{verificationStats.rejected}</dd>
                </div>
                <div>
                  <dt className="text-text-muted">Unavailable</dt>
                  <dd>{verificationStats.unavailable}</dd>
                </div>
                <div>
                  <dt className="text-text-muted">Incompatible or skipped</dt>
                  <dd>{verificationStats.skipped}</dd>
                </div>
                <div>
                  <dt className="text-text-muted">Average review time</dt>
                  <dd>{Math.round(verificationStats.averageLatencyMs)} ms</dd>
                </div>
                <div>
                  <dt className="text-text-muted">Known review cost</dt>
                  <dd>${verificationStats.knownEvaluationCostUsd.toFixed(6)}</dd>
                </div>
                <div>
                  <dt className="text-text-muted">Estimated generation avoided</dt>
                  <dd>${verificationStats.avoidedCostEstimateUsd.toFixed(6)}</dd>
                </div>
                <div>
                  <dt className="text-text-muted">Unpriced checks</dt>
                  <dd>{verificationStats.unpricedEvaluations}</dd>
                </div>
              </dl>
              <p className="text-xs text-text-muted mt-2">
                Costs use reported usage and catalog prices. Avoided generation is an estimate;
                embedding costs are excluded.
              </p>
              {statsError && (
                <p role="alert" className="text-xs text-red-600">
                  Activity could not be refreshed. Showing the last snapshot.
                </p>
              )}
            </div>
          )}
          {/* Action Buttons & Feedback */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-border/50">
            <div className="flex items-center gap-2">
              {semEnabled && semVectorEnabled && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleTestConnection}
                  disabled={testingConnection || semSaving}
                >
                  {testingConnection ? "Testing Connection..." : "Test Embedding Model"}
                </Button>
              )}

              <Button
                size="sm"
                variant="ghost"
                onClick={handleClearCache}
                disabled={clearingCache}
                className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
              >
                {clearingCache ? "Purging..." : "Clear Cache"}
              </Button>
            </div>

            <Button
              size="sm"
              variant="primary"
              onClick={saveSemanticCache}
              disabled={
                catalogLoading ||
                !configLoaded ||
                semSaving ||
                (reusePolicy === "verified" && (!verificationReady || !verificationTuningValid))
              }
            >
              {semSaving ? "Saving..." : "Save response reuse"}
            </Button>
          </div>

          {/* Test Connection Output */}
          {testResult && (
            <div
              className={`p-3 rounded-md text-xs border ${
                testResult.ok
                  ? "bg-green-500/10 border-green-500/20 text-green-700 dark:text-green-300"
                  : "bg-red-500/10 border-red-500/20 text-red-700 dark:text-red-300"
              }`}
            >
              {testResult.ok ? (
                <div className="flex items-center gap-2">
                  <span className="font-bold">Connection Verified:</span>
                  <span>
                    Successfully generated {testResult.dimensions}-dim embedding in{" "}
                    {testResult.latencyMs}ms
                    {testResult.resolvedBaseUrl ? ` via ${testResult.resolvedBaseUrl}` : ""}.
                  </span>
                </div>
              ) : (
                <div>
                  <span className="font-bold">Connection Test Failed: </span>
                  <span>{testResult.error || "Unknown error"}</span>
                </div>
              )}
            </div>
          )}

          {/* Clear Message */}
          {clearMessage && <p className="text-xs text-text-muted italic">{clearMessage}</p>}

          {/* Save Message */}
          {semMessage && (
            <p
              className={`text-xs ${
                semMessage.type === "success"
                  ? "text-green-600 dark:text-green-400 font-medium"
                  : "text-red-600 dark:text-red-400"
              }`}
            >
              {semMessage.text}
            </p>
          )}
        </div>
      </Card>

      {/* ── 2. Model Catalog Cache Card (Preserved Compatibility) ── */}
      <Card className="p-6">
        <div className="flex flex-col gap-3">
          <div>
            <p className="font-medium">{t("modelCatalogCacheTtl")}</p>
            <p className="text-sm text-text-muted mt-1">{t("modelCatalogCacheTtlDescription")}</p>
          </div>
          <div className="flex items-center gap-3">
            <label htmlFor="model-catalog-ttl-ms" className="sr-only">
              {t("modelCatalogCacheTtlLabel")}
            </label>
            <input
              id="model-catalog-ttl-ms"
              type="number"
              min={MIN_TTL_MS}
              max={MAX_TTL_MS}
              step={100}
              value={catalogTtl}
              onChange={(event) => {
                setCatalogTtl(event.target.value);
                setCatalogMessage(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && catalogDirty) void saveCatalogTtl();
              }}
              className="w-32 px-3 py-1.5 rounded bg-surface-2 border border-border text-sm text-text-primary"
              disabled={catalogLoading || catalogSaving}
            />
            <span className="text-xs text-text-muted">ms</span>
            <Button
              size="sm"
              variant="primary"
              disabled={
                !configLoaded ||
                catalogLoading ||
                catalogSaving ||
                Boolean(catalogValidationError) ||
                !catalogDirty
              }
              onClick={saveCatalogTtl}
            >
              {catalogSaving ? t("modelCatalogCacheTtlSaving") : t("modelCatalogCacheTtlSave")}
            </Button>
            {catalogDirty && (
              <span className="text-xs text-text-muted">
                {t("modelCatalogCacheTtlCurrent", { value: savedCatalogTtl })}
              </span>
            )}
          </div>
          {catalogValidationError && (
            <p className="text-xs text-red-500">{catalogValidationError}</p>
          )}
          {catalogMessage && (
            <p
              className={`text-xs ${
                catalogMessage.type === "success"
                  ? "text-green-600 dark:text-green-400"
                  : "text-red-600 dark:text-red-400"
              }`}
            >
              {catalogMessage.text}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
