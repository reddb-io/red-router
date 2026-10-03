import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import ProviderModelsSection, {
  type ProviderModelsSectionProps,
} from "@/app/(dashboard)/dashboard/providers/[id]/components/ProviderModelsSection";

vi.mock("@/app/(dashboard)/dashboard/providers/[id]/components/ModelRow", () => ({
  default: () => null,
  ModelVisibilityToolbar: () => null,
}));

it("Codex offers clear for a synced-only catalog, even without custom models, aliases or import", async () => {
  const clear = vi.fn(async () => {});
  const noop = vi.fn(async () => {});
  const props: ProviderModelsSectionProps = {
    providerId: "codex",
    providerAlias: "cx",
    providerStorageAlias: "cx",
    providerDisplayAlias: "cx",
    providerInfo: { name: "Codex" },
    isCcCompatible: false,
    isAnthropicCompatible: false,
    isAnthropicProtocolCompatible: false,
    isManagedAvailableModelsProvider: false,
    compatibleSupportsModelImport: false,
    allowModelImport: false,
    models: [{ id: "gpt-6.1-sol" }],
    syncedAvailableModels: [{ id: "gpt-6.1-sol" }],
    modelMeta: { customModels: [] },
    modelAliases: {},
    compatibleFallbackModels: [],
    copied: null,
    onCopy: noop,
    onSetAlias: noop,
    onDeleteAlias: noop,
    fetchProviderModelMeta: noop,
    connections: [],
    selectedConnection: null,
    canImportModels: false,
    importingModels: false,
    handleImportModels: noop,
    isAutoSyncEnabled: false,
    togglingAutoSync: false,
    handleToggleAutoSync: noop,
    isAutoFetchModelsEnabled: false,
    togglingAutoFetchModels: false,
    handleToggleAutoFetchModels: noop,
    handleCompatibleImportWithProgress: noop,
    compatSavingModelId: null,
    togglingModelId: null,
    bulkVisibilityAction: null,
    clearingModels: false,
    modelFilter: "",
    testingModelId: null,
    modelTestStatus: {},
    onModelTestStatusChange: noop,
    testingAll: false,
    testProgress: null,
    autoHideFailed: false,
    visibilityFilter: "all",
    providerAliasEntries: [],
    setModelFilter: noop,
    setAutoHideFailed: noop,
    setVisibilityFilter: noop,
    saveModelCompatFlags: noop,
    handleToggleModelHidden: noop,
    handleBulkToggleModelHidden: noop,
    handleClearAllModels: clear,
    onTestModel: noop,
    handleTestAll: noop,
    effectiveModelNormalize: () => false,
    effectiveModelPreserveDeveloper: () => false,
    effectiveModelHidden: () => true,
    getUpstreamHeadersRecordForModel: () => ({}),
    t: (key) => key,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ProviderModelsSection {...props} />));
    const button = container.querySelector<HTMLButtonElement>('button[title="clearAllModels"]')!;
    expect(button).toBeTruthy();
    await act(async () => button.click());
    expect(clear).toHaveBeenCalledOnce();
    await act(async () => root.render(<ProviderModelsSection {...props} clearingModels />));
    expect(
      container.querySelector<HTMLButtonElement>('button[title="clearAllModels"]')!.disabled
    ).toBe(true);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
