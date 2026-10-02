"use client";

/**
 * useModelVisibilityHandlers — Issue #3501 Phase 1l
 *
 * Owns model-visibility/compat state and handlers previously inline in
 * ProviderDetailPageClient:
 *  - State: compatSavingModelId, togglingModelId, bulkVisibilityAction,
 *           clearingModels, modelFilter, testingModelId, modelTestStatus,
 *           testingAll, testProgress, autoHideFailed, visibilityFilter
 *  - Derived: providerAliasEntries
 *  - Handlers: saveModelCompatFlags, handleToggleModelHidden,
 *              handleBulkToggleModelHidden, handleClearAllModels,
 *              onTestModel, handleTestAll
 *
 * onTestModel and handleTestAll share handleToggleModelHidden — kept in the
 * same hook to avoid cross-hook cycles.
 *
 * Cycle-safe: imports only from leaf modules. No import from
 * ProviderDetailPageClient.
 */

import { useState, useMemo, useRef, useEffect } from "react";
import type { ModelTestFeedbackState } from "../components/ModelTestFeedback";
import {
  formatProviderModelsErrorResponse,
  providerText,
  testAllResultsText,
  evaluateTestAllEntry,
  shouldSwitchToVisibleFilter,
  type ProviderMessageTranslator,
  type CompatByProtocolMap,
} from "../providerPageHelpers";
import { useNotificationStore } from "@/store/notificationStore";
import { extractApiErrorMessage } from "@/shared/http/apiErrorMessage";
import { awaitWithAbort } from "@/shared/utils/awaitWithAbort";

export function modelTestClientTimeoutMs(providerId: string): number {
  // Allow the server's provider-specific deadline plus time to return the diagnostic.
  switch (providerId.trim().toLowerCase()) {
    case "nvidia":
      return 190_000;
    case "doubao-web":
      return 100_000;
    case "zai-web":
      return 70_000;
    default:
      return 40_000;
  }
}

type NotifyStore = ReturnType<typeof useNotificationStore>;

// ──── types ──────────────────────────────────────────────────────────────────

/** Subset of ModelCompatSavePatch fields needed by this hook. */
export interface ModelCompatSavePatch {
  normalizeToolCallId?: boolean;
  preserveOpenAIDeveloperRole?: boolean;
  upstreamHeaders?: Record<string, string>;
  compatByProtocol?: CompatByProtocolMap;
  isHidden?: boolean;
}

export interface UseModelVisibilityHandlersParams {
  providerId: string;
  modelAliases: Record<string, string>;
  /** The computed custom-model map from useModelCompatState. */
  customMap: Map<string, unknown>;
  providerStorageAlias: string;
  fetchProviderModelMeta: () => Promise<void>;
  fetchAliases: () => Promise<void>;
  notify: NotifyStore;
  t: ProviderMessageTranslator;
  formatProviderModelsErrorResponse?: typeof formatProviderModelsErrorResponse;
  /** The current selected connection (may be null). */
  selectedConnection: any;
  /** The provider node (may be null). */
  providerNode: any;
}

export interface UseModelVisibilityHandlersReturn {
  compatSavingModelId: string | null;
  togglingModelId: string | null;
  bulkVisibilityAction: "select" | "deselect" | null;
  clearingModels: boolean;
  modelFilter: string;
  testingModelId: string | null;
  modelTestStatus: Record<string, "ok" | "error" | "quota">;
  modelTestFeedback: ModelTestFeedbackState | null;
  testingAll: boolean;
  testProgress: { done: number; total: number } | null;
  autoHideFailed: boolean;
  visibilityFilter: "all" | "visible" | "hidden";
  providerAliasEntries: [string, string][];
  setModelFilter: (v: string) => void;
  setAutoHideFailed: (v: boolean) => void;
  setVisibilityFilter: (v: "all" | "visible" | "hidden") => void;
  saveModelCompatFlags: (modelId: string, patch: ModelCompatSavePatch) => Promise<void>;
  handleToggleModelHidden: (providerKey: string, modelId: string, hidden: boolean) => Promise<void>;
  handleBulkToggleModelHidden: (
    providerKey: string,
    modelIds: string[],
    hidden: boolean
  ) => Promise<void>;
  handleClearAllModels: () => Promise<void>;
  onTestModel: (modelId: string, fullModel: string) => Promise<void>;
  handleTestAll: (targets: Array<{ modelId: string; fullModel: string }>) => Promise<void>;
  /** Apply a model's test-all result to the per-row status icon (used by the
   *  passthrough section, which runs its own test-all loop). */
  onModelTestStatusChange: (modelId: string, status: "ok" | "error" | "quota") => void;
}

// ──── hook ───────────────────────────────────────────────────────────────────

export function useModelVisibilityHandlers({
  providerId,
  modelAliases,
  customMap,
  providerStorageAlias,
  fetchProviderModelMeta,
  fetchAliases,
  notify,
  t,
  selectedConnection,
  providerNode,
}: UseModelVisibilityHandlersParams): UseModelVisibilityHandlersReturn {
  const [compatSavingModelId, setCompatSavingModelId] = useState<string | null>(null);
  const [togglingModelId, setTogglingModelId] = useState<string | null>(null);
  const [bulkVisibilityAction, setBulkVisibilityAction] = useState<"select" | "deselect" | null>(
    null
  );
  const [clearingModels, setClearingModels] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [modelTestFeedback, setModelTestFeedback] = useState<ModelTestFeedbackState | null>(null);
  const activeTest = useRef<AbortController | null>(null);
  useEffect(() => {
    const slot = activeTest;
    return () => {
      const controller = slot.current;
      slot.current = null;
      controller?.abort();
    };
  }, [providerId, selectedConnection?.id]);
  const [modelTestStatus, setModelTestStatus] = useState<Record<string, "ok" | "error" | "quota">>(
    {}
  );
  const testScope = JSON.stringify([providerId, selectedConnection?.id ?? null]);
  const [previousTestScope, setPreviousTestScope] = useState(testScope);
  // Reset connection-specific results before rendering the new connection.
  if (previousTestScope !== testScope) {
    setPreviousTestScope(testScope);
    setTestingModelId(null);
    setModelTestFeedback(null);
    setModelTestStatus({});
  }
  const [testingAll, setTestingAll] = useState(false);
  const [testProgress, setTestProgress] = useState<{ done: number; total: number } | null>(null);
  const [autoHideFailed, setAutoHideFailed] = useState(false);
  const [visibilityFilter, setVisibilityFilter] = useState<"all" | "visible" | "hidden">("all");

  const providerAliasEntries = useMemo(
    () =>
      Object.entries(modelAliases).filter(
        ([, model]) => typeof model === "string" && model.startsWith(`${providerStorageAlias}/`)
      ) as [string, string][],
    [modelAliases, providerStorageAlias]
  );

  const saveModelCompatFlags = async (modelId: string, patch: ModelCompatSavePatch) => {
    setCompatSavingModelId(modelId);
    try {
      const c = customMap.get(modelId) as Record<string, unknown> | undefined;
      let body: Record<string, unknown>;
      const onlyCompatByProtocol =
        patch.compatByProtocol &&
        patch.normalizeToolCallId === undefined &&
        patch.preserveOpenAIDeveloperRole === undefined &&
        !("upstreamHeaders" in patch);

      if (c) {
        if (onlyCompatByProtocol) {
          body = {
            provider: providerId,
            modelId,
            compatByProtocol: patch.compatByProtocol,
          };
        } else {
          body = {
            provider: providerId,
            modelId,
            modelName: (c.name as string) || modelId,
            source: (c.source as string) || "manual",
            apiFormat: (c.apiFormat as string) || "chat-completions",
            supportedEndpoints:
              Array.isArray(c.supportedEndpoints) && (c.supportedEndpoints as unknown[]).length
                ? c.supportedEndpoints
                : ["chat"],
            normalizeToolCallId:
              patch.normalizeToolCallId !== undefined
                ? patch.normalizeToolCallId
                : Boolean(c.normalizeToolCallId),
            preserveOpenAIDeveloperRole:
              patch.preserveOpenAIDeveloperRole !== undefined
                ? patch.preserveOpenAIDeveloperRole
                : Object.prototype.hasOwnProperty.call(c, "preserveOpenAIDeveloperRole")
                  ? Boolean(c.preserveOpenAIDeveloperRole)
                  : true,
          };
          if (patch.compatByProtocol) body.compatByProtocol = patch.compatByProtocol;
        }
      } else {
        body = { provider: providerId, modelId, ...patch };
      }
      const res = await fetch("/api/provider-models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await formatProviderModelsErrorResponse(res);
        notify.error(
          detail ? `${t("failedSaveCustomModel")} — ${detail}` : t("failedSaveCustomModel")
        );
        return;
      }
    } catch {
      notify.error(t("failedSaveCustomModel"));
      return;
    } finally {
      setCompatSavingModelId(null);
    }
    try {
      await fetchProviderModelMeta();
    } catch {
      /* refresh failure is non-critical — data was already saved */
    }
  };

  const handleToggleModelHidden = async (
    providerKey: string,
    modelId: string,
    hidden: boolean
  ): Promise<void> => {
    setTogglingModelId(modelId);
    try {
      const res = await fetch(
        `/api/provider-models?provider=${encodeURIComponent(providerKey)}&modelId=${encodeURIComponent(modelId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          // Explicit selection activates this model across its supported endpoints.
          body: JSON.stringify({ isActive: !hidden }),
        }
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        notify.error(detail || t("failedSaveCustomModel"));
        return;
      }
      await Promise.all([fetchProviderModelMeta().catch(() => {}), fetchAliases().catch(() => {})]);
    } catch {
      notify.error(t("failedSaveCustomModel"));
    } finally {
      setTogglingModelId(null);
    }
  };

  const handleBulkToggleModelHidden = async (
    providerKey: string,
    modelIds: string[],
    hidden: boolean
  ): Promise<void> => {
    if (modelIds.length === 0) return;
    setBulkVisibilityAction(hidden ? "deselect" : "select");
    try {
      const res = await fetch(`/api/provider-models?provider=${encodeURIComponent(providerKey)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !hidden, modelIds }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        notify.error(detail || t("failedSaveCustomModel"));
        return;
      }
      await Promise.all([fetchProviderModelMeta().catch(() => {}), fetchAliases().catch(() => {})]);
    } catch {
      notify.error(t("failedSaveCustomModel"));
    } finally {
      setBulkVisibilityAction(null);
    }
  };

  const handleClearAllModels = async () => {
    if (clearingModels) return;
    if (!confirm(t("clearAllModelsConfirm"))) return;
    setClearingModels(true);
    try {
      const res = await fetch(
        `/api/provider-models?provider=${encodeURIComponent(providerId)}&all=true`,
        { method: "DELETE" }
      );
      if (res.ok) {
        // Also delete all aliases that belong to this provider
        await Promise.all(
          providerAliasEntries.map(([alias]) =>
            fetch(`/api/models/alias?alias=${encodeURIComponent(alias)}`, {
              method: "DELETE",
            }).catch(() => {})
          )
        );
        await fetchProviderModelMeta();
        await fetchAliases();
        notify.success(t("clearAllModelsSuccess"));
      } else {
        notify.error(t("clearAllModelsFailed"));
      }
    } catch {
      notify.error(t("clearAllModelsFailed"));
    } finally {
      setClearingModels(false);
    }
  };

  const onTestModel = async (modelId: string, fullModel: string) => {
    activeTest.current?.abort();
    const controller = new AbortController();
    activeTest.current = controller;
    const dispatchProvider = selectedConnection?.provider || providerNode?.id || providerId;
    const clientTimeoutMs = modelTestClientTimeoutMs(dispatchProvider);
    const startedAt = Date.now();
    const timer = setTimeout(
      () => controller.abort(new DOMException("Model test deadline exceeded", "TimeoutError")),
      clientTimeoutMs
    );
    const showFeedback = (result: ModelTestFeedbackState) => {
      if (activeTest.current === controller) setModelTestFeedback(result);
    };
    showFeedback({
      model: fullModel,
      status: "testing",
      message: "Waiting for the provider response…",
    });
    setTestingModelId(modelId);
    setModelTestStatus((prev) => {
      const next = { ...prev };
      delete next[modelId];
      return next;
    });
    try {
      const { res, data } = await awaitWithAbort(async () => {
        const res = await fetch("/api/models/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerId: dispatchProvider,
            modelId: fullModel,
            connectionId: selectedConnection?.id,
          }),
          signal: controller.signal,
        });
        const data = await res.json();
        return { res, data };
      }, controller.signal);
      if (activeTest.current !== controller) return;
      if (res.ok && data.status === "ok") {
        showFeedback({
          model: fullModel,
          status: "ok",
          message: "Model responded successfully.",
          latencyMs: data.latencyMs,
          statusCode: res.status,
        });
        notify.success(
          providerText(
            t,
            "testModelSuccess",
            `Model ${modelId} is working. Latency: ${data.latencyMs}ms`,
            {
              modelId,
              latencyMs: data.latencyMs,
            }
          )
        );
        setModelTestStatus((prev) => ({ ...prev, [modelId]: "ok" }));
      } else {
        // extractApiErrorMessage coerces any object-shaped `error` (e.g. a Zod
        // format object) to a string so notify.error never hands the toast a
        // non-string child (React #31 → frozen page).
        const message = extractApiErrorMessage(
          data,
          providerText(t, "modelTestFailed", "Model test failed")
        );
        showFeedback({
          model: fullModel,
          status: "error",
          message,
          latencyMs: data.latencyMs,
          statusCode: data.statusCode ?? res.status,
        });
        notify.error(message);
        setModelTestStatus((prev) => ({ ...prev, [modelId]: "error" }));
      }
    } catch (err) {
      if (activeTest.current !== controller) return;
      const message = controller.signal.aborted
        ? `Test timed out after ${Math.round(clientTimeoutMs / 1000)} seconds while waiting for RedRouter. Check the connection address and provider logs, then retry.`
        : providerText(t, "modelTestNetworkError", "Network error testing model");
      showFeedback({
        model: fullModel,
        status: "error",
        message,
        latencyMs: Date.now() - startedAt,
      });
      notify.error(message);
      setModelTestStatus((prev) => ({ ...prev, [modelId]: "error" }));
    } finally {
      clearTimeout(timer);
      if (activeTest.current === controller) {
        setTestingModelId(null);
        activeTest.current = null;
      }
    }
  };

  const handleTestAll = async (
    targets: Array<{ modelId: string; fullModel: string }>
  ): Promise<void> => {
    if (testingAll) return;
    if (targets.length === 0) {
      notify.error("No active models match the current filter");
      return;
    }
    setTestingAll(true);
    setTestProgress({ done: 0, total: targets.length });

    let ok = 0;
    let error = 0;
    let hiddenCount = 0;

    const CHUNK_SIZE = 3;
    for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
      const chunk = targets.slice(i, i + CHUNK_SIZE);
      await Promise.all(
        chunk.map(async ({ modelId, fullModel }) => {
          try {
            const result: {
              results?: Record<
                string,
                {
                  status?: "ok" | "error" | "slow";
                  rateLimited?: boolean;
                  isTimeout?: boolean;
                  error?: string;
                }
              >;
            } = await fetch("/api/models/test-all", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                providerId: providerId,
                connectionId: selectedConnection?.id,
                modelIds: [fullModel],
              }),
            }).then((r) => r.json());

            const entry = result.results?.[fullModel];
            const outcome = evaluateTestAllEntry(entry, autoHideFailed);
            // #9511: paint "quota" status for quota-exhausted models (amber badge),
            // "ok" for healthy, "error" for genuine failures.
            setModelTestStatus((prev) => ({
              ...prev,
              [modelId]: outcome.isQuota ? "quota" : outcome.status,
            }));
            if (outcome.status === "ok") {
              ok++;
            } else {
              error++;
              if (outcome.shouldHide) {
                // Hidden flag keyed by providerId — same as the manual eye toggle and the read
                // (fetchProviderModelMeta). providerStorageAlias wrote it under the alias while the
                // read looked under the canonical id, so auto-hide never reflected.
                await handleToggleModelHidden(providerId, modelId, true);
                hiddenCount++;
              }
            }
          } catch (e) {
            error++;
            setModelTestStatus((prev) => ({ ...prev, [modelId]: "error" }));
          }
          setTestProgress((prev) => (prev ? { done: prev.done + 1, total: prev.total } : null));
        })
      );
    }

    notify.info(testAllResultsText(t, ok, ok + error));
    if (hiddenCount > 0) {
      notify.info(providerText(t, "testAllFailedHidden", "{count} hidden", { count: hiddenCount }));
      // Bug #4887: switch to "visible" so the models we just auto-hid disappear
      // on-screen — parity with PassthroughModelsSection (#3610). Without this,
      // failed models were hidden in the DB but stayed visible under the "All"
      // filter, so on GLM (and other OAuth providers using this hook's handleTestAll)
      // it looked like nothing was hidden.
      if (shouldSwitchToVisibleFilter({ autoHideFailed, hiddenCount })) {
        setVisibilityFilter("visible");
      }
    }
    setTestingAll(false);
    setTestProgress(null);
  };

  return {
    compatSavingModelId,
    togglingModelId,
    bulkVisibilityAction,
    clearingModels,
    modelFilter,
    testingModelId,
    modelTestStatus,
    modelTestFeedback,
    testingAll,
    testProgress,
    autoHideFailed,
    visibilityFilter,
    providerAliasEntries,
    setModelFilter,
    setAutoHideFailed,
    setVisibilityFilter,
    saveModelCompatFlags,
    handleToggleModelHidden,
    handleBulkToggleModelHidden,
    handleClearAllModels,
    onTestModel,
    handleTestAll,
    onModelTestStatusChange: (modelId: string, status: "ok" | "error" | "quota") =>
      setModelTestStatus((prev) => ({ ...prev, [modelId]: status })),
  };
}
