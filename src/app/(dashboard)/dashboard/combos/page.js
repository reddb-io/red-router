"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import DecisionRouterCard from "@/shared/components/DecisionRouterCard";
import ReasoningAutopilotCard from "@/shared/components/ReasoningAutopilotCard";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { Card, Button, Modal, Input, CardSkeleton, ModelSelectModal, ConfirmModal, CapacityBadges, Select, Toggle, RecommendedSetup } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { publicModelRef } from "@/shared/utils/modelRef";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// Capacity adapter: global fallback pools of models per input-modality capability.
// A request needing a capability the target model/combo lacks switches straight
// to the first enabled model here instead of erroring or dropping the data.
const CAPACITY_ADAPTER_CAPS = [
  { key: "vision", label: "Vision", icon: "visibility", desc: "Images" },
  // pdf, videoInput temporarily hidden — no translator support yet for those blocks.
  { key: "audioInput", label: "Audio", icon: "graphic_eq", desc: "Audio input" },
];
const DEFAULT_FALLBACK_MODEL = "oc/mimo-v2.5-free";
const EMPTY_CAP_ENTRY = { enabled: true, roundRobin: false, models: [] };
const EMPTY_CAPACITY_ADAPTER = {
  vision: { ...EMPTY_CAP_ENTRY },
  pdf: { ...EMPTY_CAP_ENTRY },
  audioInput: { ...EMPTY_CAP_ENTRY },
  videoInput: { ...EMPTY_CAP_ENTRY },
};
// Backward-compat: legacy stored form was an array of {model, enabled}.
function normalizeCapEntry(entry) {
  if (Array.isArray(entry)) {
    return { enabled: true, roundRobin: false, models: entry.map((e) => e?.model || e).filter(Boolean) };
  }
  if (entry && typeof entry === "object") {
    return {
      enabled: entry.enabled !== false,
      roundRobin: !!entry.roundRobin,
      models: Array.isArray(entry.models) ? entry.models.filter(Boolean) : [],
    };
  }
  return { ...EMPTY_CAP_ENTRY };
}

const STRATEGY_OPTIONS = [
  { value: "fallback", label: "Fallback — try in order" },
  { value: "round-robin", label: "Round Robin — rotate" },
  { value: "fusion", label: "Fusion — panel + judge" },
  { value: "smart", label: "Smart — Jev complexity routing" },
  { value: "auto", label: "Auto — decision model picks per turn" },
];

// One card per strategy in the page header; order follows STRATEGY_OPTIONS.
const STRATEGY_SUMMARY = [
  { key: "fallback", label: "Fallback", icon: "low_priority", desc: "Tries models in order; the next one runs when one fails." },
  { key: "round-robin", label: "Round Robin", icon: "autorenew", desc: "Rotates models across requests to spread load." },
  { key: "fusion", label: "Fusion", icon: "hub", desc: "Queries every model in parallel and a judge merges one answer. Bills N+1 calls." },
  { key: "smart", label: "Smart", icon: "psychology", desc: "Classifies task complexity and leads with the matching tier's model." },
  { key: "auto", label: "Auto", icon: "alt_route", desc: "A decision model picks which member leads, per turn." },
];

// Client presets: combos named like a client's built-in model IDs.
const CLIENT_PRESETS = [
  { source: "cursor", label: "Cursor Default", icon: "edit_note", desc: "Named like Cursor model IDs, seeded with cu/…" },
  { source: "claude", label: "Claude Default", icon: "smart_toy", desc: "Named like Claude Code model IDs, seeded with cc/…" },
];

export default function CombosPage() {
  const [combos, setCombos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingCombo, setEditingCombo] = useState(null);
  const [activeProviders, setActiveProviders] = useState([]);
  const [comboStrategies, setComboStrategies] = useState({});
  const [capacityAdapter, setCapacityAdapter] = useState(EMPTY_CAPACITY_ADAPTER);
  const { getCaps } = useModelCaps();
  const [confirmState, setConfirmState] = useState(null);
  const [presetLoading, setPresetLoading] = useState(null);
  const [showRecommended, setShowRecommended] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const { copied, copy } = useCopyToClipboard();
  const [identity, setIdentity] = useState({ isAdmin: true, scoped: false });
  const [hiddenShared, setHiddenShared] = useState([]);

  useEffect(() => {
    // Legacy loader mutates local component state after its requests resolve.
    // eslint-disable-next-line react-hooks/immutability
    fetchData();
  }, []);

  const editableCombos = combos.filter((c) => !c.readOnly);
  const selectedCombos = editableCombos.filter((c) => selectedIds.includes(c.id));
  const allSelected = editableCombos.length > 0 && selectedCombos.length === editableCombos.length;
  const someSelected = selectedCombos.length > 0;

  const toggleSelect = (id) => {
    setSelectedIds((prev) => (
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    ));
  };

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? [] : editableCombos.map((c) => c.id));
  };

  const clearSelection = () => setSelectedIds([]);

  const handleGeneratePresets = async (source) => {
    const label = source === "cursor" ? "Cursor Default" : "Claude Default";
    setPresetLoading(source);
    try {
      const previewRes = await fetch(`/api/combos/presets?source=${source}`);
      const preview = await previewRes.json();
      if (!previewRes.ok) {
        alert(preview.error || `Failed to preview ${label}`);
        return;
      }

      const toCreate = preview.toCreate ?? (preview.items || []).filter((i) => !i.exists).length;
      const toSkip = preview.toSkip ?? (preview.items || []).filter((i) => i.exists).length;
      const total = (preview.items || []).length;

      if (total === 0) {
        alert(`No ${label} models available to generate.`);
        return;
      }

      if (toCreate === 0) {
        alert(`All ${total} ${label} combos already exist. Nothing to create.`);
        return;
      }

      setConfirmState({
        title: `Generate ${label}`,
        message: `Create ${toCreate} combo${toCreate === 1 ? "" : "s"} named like ${source === "cursor" ? "Cursor" : "Claude"} model IDs (seeded with ${source === "cursor" ? "cu/…" : "cc/…"}). ${toSkip} already exist and will be skipped. You can edit any combo afterward to add fallbacks.${source === "cursor" ? " Note: Cursor often blocks built-in Composer / Grok on a custom OpenAI base URL (\"model does not support custom API\"); add them via Cursor's Add Custom Model using the combo name." : ""}`,
        confirmText: "Generate",
        variant: "primary",
        onConfirm: async () => {
          setConfirmState((prev) => prev ? { ...prev, loading: true } : null);
          try {
            const res = await fetch("/api/combos/presets", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ source }),
            });
            const data = await res.json();
            if (!res.ok) {
              alert(data.error || `Failed to generate ${label}`);
              return;
            }
            await fetchData();
            setConfirmState(null);
          } catch (error) {
            console.log(`Error generating ${label}:`, error);
            alert(`Failed to generate ${label}`);
            setConfirmState((prev) => prev ? { ...prev, loading: false } : null);
          }
        },
      });
    } catch (error) {
      console.log(`Error previewing ${label}:`, error);
      alert(`Failed to preview ${label}`);
    } finally {
      setPresetLoading(null);
    }
  };

  const fetchData = async () => {
    try {
      const [combosRes, providersRes, settingsRes, statusRes] = await Promise.all([
        fetch("/api/combos"),
        fetch("/api/providers"),
        fetch("/api/settings"),
        fetch("/api/auth/status"),
      ]);
      if (statusRes.ok) {
        const st = await statusRes.json();
        setIdentity({ isAdmin: !st.scopeResourcesByUser || !!st.isAdmin, scoped: !!st.scopeResourcesByUser });
      }
      const combosData = await combosRes.json();
      const providersData = await providersRes.json();
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      
      // Only LLM combos here - webSearch/webFetch combos belong to media-providers/web
      if (combosRes.ok) {
        setCombos((combosData.combos || []).filter(c => !c.kind || c.kind === "llm"));
        setHiddenShared(combosData.hiddenSharedCombos || []);
      }
      if (providersRes.ok) {
        setActiveProviders(providersData.connections || []);
      }
      setComboStrategies(settingsData.comboStrategies || {});
      const rawAdapter = settingsData.capacityAdapter || {};
      const normalized = {};
      for (const cap of CAPACITY_ADAPTER_CAPS) {
        normalized[cap.key] = normalizeCapEntry(rawAdapter[cap.key]);
      }
      setCapacityAdapter(normalized);
    } catch (error) {
      console.log("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSetCapacityAdapter = async (next) => {
    setCapacityAdapter(next);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capacityAdapter: next }),
      });
    } catch (error) {
      console.log("Error updating capacity adapter:", error);
    }
  };

  // Hiding a shared combo frees its name for one of the user's own; restoring it
  // is refused while a combo of that name still exists on the account.
  const handleToggleHidden = async (name, hidden) => {
    try {
      const res = await fetch("/api/combos/hidden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, hidden }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || "Failed to update"); return; }
      await fetchData();
    } catch {
      alert("Failed to update");
    }
  };

  const handleCreate = async (data) => {
    try {
      const res = await fetch("/api/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        await fetchData();
        setShowCreateModal(false);
      } else {
        const err = await res.json();
        alert(err.error || "Failed to create combo");
      }
    } catch (error) {
      console.log("Error creating combo:", error);
    }
  };

  const handleUpdate = async (id, data) => {
    try {
      const res = await fetch(`/api/combos/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        await fetchData();
        setEditingCombo(null);
      } else {
        const err = await res.json();
        alert(err.error || "Failed to update combo");
      }
    } catch (error) {
      console.log("Error updating combo:", error);
    }
  };

  const pruneStrategiesForNames = (names, base = comboStrategies) => {
    const updated = { ...base };
    for (const name of names) delete updated[name];
    return updated;
  };

  const persistComboStrategies = async (updated) => {
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comboStrategies: updated }),
    });
    setComboStrategies(updated);
  };

  const handleDelete = async (id) => {
    const combo = combos.find((c) => c.id === id);
    setConfirmState({
      title: "Delete Combo",
      message: combo ? `Delete combo "${combo.name}"?` : "Delete this combo?",
      onConfirm: async () => {
        setConfirmState((prev) => prev ? { ...prev, loading: true } : null);
        try {
          const res = await fetch(`/api/combos/${id}`, { method: "DELETE" });
          if (res.ok) {
            if (combo?.name) {
              await persistComboStrategies(pruneStrategiesForNames([combo.name]));
            }
            setCombos((prev) => prev.filter((c) => c.id !== id));
            setSelectedIds((prev) => prev.filter((x) => x !== id));
          }
          setConfirmState(null);
        } catch (error) {
          console.log("Error deleting combo:", error);
          setConfirmState((prev) => prev ? { ...prev, loading: false } : null);
        }
      }
    });
  };

  const handleBulkDelete = () => {
    if (selectedCombos.length === 0) return;
    const count = selectedCombos.length;
    setConfirmState({
      title: "Delete Selected Combos",
      message: `Delete ${count} selected combo${count === 1 ? "" : "s"}? This cannot be undone.`,
      confirmText: "Delete",
      variant: "danger",
      onConfirm: async () => {
        setConfirmState((prev) => prev ? { ...prev, loading: true } : null);
        setBulkBusy(true);
        try {
          const ids = selectedCombos.map((c) => c.id);
          const names = selectedCombos.map((c) => c.name);
          const results = await Promise.all(
            ids.map((id) => fetch(`/api/combos/${id}`, { method: "DELETE" }))
          );
          const failed = results.filter((r) => !r.ok).length;
          await persistComboStrategies(pruneStrategiesForNames(names));
          setCombos((prev) => prev.filter((c) => !ids.includes(c.id)));
          clearSelection();
          setConfirmState(null);
          if (failed > 0) alert(`Deleted with ${failed} failure${failed === 1 ? "" : "s"}.`);
        } catch (error) {
          console.log("Error bulk deleting combos:", error);
          alert("Failed to delete selected combos");
          setConfirmState((prev) => prev ? { ...prev, loading: false } : null);
        } finally {
          setBulkBusy(false);
        }
      },
    });
  };

  // Merge a per-combo strategy patch into settings.comboStrategies. Passing an empty
  // patch (strategy back to default "fallback") drops the entry entirely.
  const handleSetComboStrategy = async (comboName, patch) => {
    try {
      const updated = { ...comboStrategies };
      const next = { ...(updated[comboName] || {}), ...patch };
      // Prune to keep settings clean: default fallback with no extras = no entry.
      if (!next.fallbackStrategy || next.fallbackStrategy === "fallback") {
        delete updated[comboName];
      } else {
        updated[comboName] = next;
      }

      await persistComboStrategies(updated);
    } catch (error) {
      console.log("Error updating combo strategy:", error);
    }
  };

  const handleBulkSetStrategy = async (strategy) => {
    if (selectedCombos.length === 0 || !strategy) return;
    setBulkBusy(true);
    try {
      const updated = { ...comboStrategies };
      for (const combo of selectedCombos) {
        if (!strategy || strategy === "fallback") {
          delete updated[combo.name];
        } else {
          updated[combo.name] = {
            ...(updated[combo.name] || {}),
            fallbackStrategy: strategy,
          };
        }
      }
      await persistComboStrategies(updated);
    } catch (error) {
      console.log("Error bulk updating combo strategy:", error);
      alert("Failed to update strategy for selected combos");
    } finally {
      setBulkBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-xl text-sm text-text-muted">
            Clients call one combo name; RedRouter picks the model behind it using the combo&apos;s strategy.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-shrink-0 sm:items-center">
            <ClientPresetsMenu presetLoading={presetLoading} onGenerate={handleGeneratePresets} />
            <Button variant="secondary" icon="add" onClick={() => setShowCreateModal(true)} className="whitespace-nowrap">
              Create Combo
            </Button>
            <Button icon="auto_awesome" onClick={() => setShowRecommended(true)} className="whitespace-nowrap">
              Recommended setup
            </Button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {STRATEGY_SUMMARY.map((s) => (
            <div key={s.key} className="rounded-lg border border-border bg-surface-2 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-medium text-text-main">
                <span className="material-symbols-outlined text-[18px] text-primary">{s.icon}</span>
                {s.label}
              </div>
              <p className="mt-1 text-xs text-text-muted">{s.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Combos List */}
      {combos.length === 0 ? (
        <Card>
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">layers</span>
            </div>
            <p className="text-text-main font-medium mb-1">No combos yet</p>
            <p className="text-sm text-text-muted">
              Use <span className="font-medium text-text-main">Recommended setup</span> to build combos from your connected providers, or create one yourself.
            </p>
          </div>
        </Card>
      ) : (
<div className="flex flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-muted bg-muted/50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-text-muted hover:text-primary select-none">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                onChange={toggleSelectAll}
                className="h-3.5 w-3.5 rounded border-muted text-primary focus:ring-primary"
              />
              <span>{someSelected ? `${selectedCombos.length} selected` : "Select editable combos"}</span>
            </label>
            {someSelected && (
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div className="w-full min-w-[160px] sm:w-[200px]">
                  <Select
                    options={STRATEGY_OPTIONS}
                    value=""
                    placeholder="Set strategy…"
                    disabled={bulkBusy}
                    onChange={(e) => { if (e.target.value) handleBulkSetStrategy(e.target.value); }}
                    selectClassName="py-1.5 text-xs"
                  />
                </div>
                <Button size="sm" variant="danger" icon="delete" disabled={bulkBusy} loading={bulkBusy} onClick={handleBulkDelete}>
                  Delete ({selectedCombos.length})
                </Button>
                <Button size="sm" variant="ghost" onClick={clearSelection} disabled={bulkBusy}>Clear</Button>
              </div>
            )}
          </div>

          {[
            { key: "own", title: "Your combos", rows: combos.filter((c) => !c.shared) },
            {
              key: "shared",
              title: "Shared combos",
              hint: identity.isAdmin
                ? "Visible to everyone. Users can use them but not edit them."
                : "Maintained by the admin — use them, or hide one to reuse its name.",
              rows: combos.filter((c) => c.shared),
            },
          ].map((section) => (
            section.rows.length === 0 && section.key === "own" && !identity.scoped ? null : (
              <div key={section.key} className="flex flex-col gap-3">
                {identity.scoped && (
                  <div>
                    <h2 className="text-sm font-semibold text-text-main">{section.title}</h2>
                    {section.hint && <p className="text-xs text-text-muted">{section.hint}</p>}
                  </div>
                )}
                {section.rows.length === 0 ? (
                  <p className="text-xs text-text-muted">None.</p>
                ) : section.rows.map((combo) => (
                  <ComboCard
                    key={combo.id}
                    combo={combo}
                    getCaps={getCaps}
                    activeProviders={activeProviders}
                    copied={copied}
                    onCopy={copy}
                    onEdit={combo.readOnly ? null : () => setEditingCombo(combo)}
                    onDelete={combo.readOnly ? null : () => handleDelete(combo.id)}
                    onHide={combo.readOnly ? () => handleToggleHidden(combo.name, true) : null}
                    strategy={comboStrategies[combo.name] || {}}
                    onSetStrategy={(patch) => handleSetComboStrategy(combo.name, patch)}
                    selected={selectedIds.includes(combo.id)}
                    onToggleSelect={combo.readOnly ? null : () => toggleSelect(combo.id)}
                  />
                ))}
              </div>
            )
          ))}

          {hiddenShared.length > 0 && (
            <div className="flex flex-col gap-2">
              <div>
                <h2 className="text-sm font-semibold text-text-main">Hidden shared combos</h2>
                <p className="text-xs text-text-muted">Their names are free for your own combos. Restoring one requires deleting yours of the same name first.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {hiddenShared.map((name) => (
                  <button key={name} type="button" onClick={() => handleToggleHidden(name, false)} className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-text-muted transition-colors hover:text-text-main" title="Restore this shared combo">
                    <span className="material-symbols-outlined text-[14px]">undo</span>
                    <span className="font-mono">{name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Capacity Adapter */}
      <CapacityAdapterSection
        capacityAdapter={capacityAdapter}
        onChange={handleSetCapacityAdapter}
        activeProviders={activeProviders}
        getCaps={getCaps}
      />

      {/* Intelligent routing: the decision model (JEV) that picks the member of
          `auto` combos and the reasoning autopilot. Global settings, served by
          whichever gateway (TypeSafe, Vercel AI Gateway, OpenRouter, …) is chosen. */}
      <section id="intelligent-routing" className="flex flex-col gap-4 scroll-mt-6">
        <div>
          <h2 className="text-lg font-semibold">Intelligent routing</h2>
          <p className="text-sm text-text-muted">
            A decision model (JEV) picks which member of an <code>auto</code> combo serves each turn, and can set the reasoning level.
          </p>
        </div>
        <DecisionRouterCard />
        <ReasoningAutopilotCard />
      </section>

      {/* Create Modal - Use key to force remount and reset state */}
      {showCreateModal && (
        <ComboFormModal
          key="create"
          isOpen={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          onSave={handleCreate}
          activeProviders={activeProviders}
          canAssignOwner={identity.scoped && identity.isAdmin}
        />
      )}

      {editingCombo && (
        <ComboFormModal
          key={editingCombo.id}
          isOpen={!!editingCombo}
          combo={editingCombo}
          onClose={() => setEditingCombo(null)}
          onSave={(data) => handleUpdate(editingCombo.id, data)}
          activeProviders={activeProviders}
          canAssignOwner={identity.scoped && identity.isAdmin}
        />
      )}

      <Modal
        isOpen={showRecommended}
        onClose={() => setShowRecommended(false)}
        title="Recommended setup"
        size="lg"
      >
        <p className="mb-4 text-sm text-text-muted">
          Builds <code className="font-mono">default</code>, <code className="font-mono">fast</code> and <code className="font-mono">review</code> combos from your connected providers, with fallbacks across accounts. Run it again after connecting a provider: it updates those combos instead of duplicating them.
        </p>
        {showRecommended ? <RecommendedSetup autoLoad onApplied={fetchData} /> : null}
      </Modal>

      {/* Confirm (delete / generate presets) */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => !confirmState?.loading && setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        confirmText={confirmState?.confirmText || "Confirm"}
        variant={confirmState?.variant || "danger"}
        loading={!!confirmState?.loading}
      />
    </div>
  );
}

function ClientPresetsMenu({ presetLoading, onGenerate }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="secondary"
        icon="devices"
        iconRight={open ? "expand_less" : "expand_more"}
        loading={!!presetLoading}
        disabled={!!presetLoading}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-full whitespace-nowrap"
      >
        Client presets
      </Button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-surface p-1 shadow-xl sm:left-auto sm:right-0">
          {CLIENT_PRESETS.map((p) => (
            <button
              key={p.source}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onGenerate(p.source); }}
              className="flex w-full items-start gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-surface-2"
            >
              <span className="material-symbols-outlined mt-0.5 text-[20px] text-text-muted">{p.icon}</span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-text-main">{p.label}</span>
                <span className="block text-xs text-text-muted">{p.desc}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ComboCard({ combo, getCaps, activeProviders = [], copied, onCopy, onEdit, onDelete, onHide = null, strategy = {}, onSetStrategy, selected = false, onToggleSelect = null }) {
  const [showJudgeSelect, setShowJudgeSelect] = useState(false);
  const current = strategy.fallbackStrategy || "fallback";
  const judge = strategy.judgeModel || "";
  const isFusion = current === "fusion";

  return (
    <Card padding="sm" className={`group ${selected ? "ring-1 ring-primary/40 bg-primary/[0.03]" : ""}`}>
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
          {onToggleSelect && (
            <label className="flex shrink-0 items-center pt-1 sm:pt-0 cursor-pointer" title="Select combo">
              <input
                type="checkbox"
                checked={selected}
                onChange={onToggleSelect}
                onClick={(e) => e.stopPropagation()}
                className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                aria-label={`Select ${combo.name}`}
              />
            </label>
          )}
          <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-primary text-[18px]">layers</span>
          </div>
          <div className="min-w-0 flex-1">
            <code className="block truncate font-mono text-sm font-medium">{combo.name}</code>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
              {combo.models.length === 0 ? (
                <span className="text-xs text-text-muted italic">No models</span>
              ) : (
                combo.models.slice(0, 3).map((model, index) => (
                  <code key={index} className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-text-muted">
                    <span>{publicModelRef(model)}</span>
                    <CapacityBadges caps={getCaps?.(model)} />
                  </code>
                ))
              )}
              {combo.models.length > 3 && (
                <span className="text-[10px] text-text-muted">+{combo.models.length - 3} more</span>
              )}
            </div>
            {/* Fusion: judge picker (Auto = first model) */}
            {isFusion && (
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-medium text-text-muted">Judge</span>
                <button
                  onClick={() => setShowJudgeSelect(true)}
                  className="inline-flex max-w-full items-center gap-1 rounded border border-dashed border-primary/40 px-1.5 py-0.5 font-mono text-[11px] text-primary hover:border-primary hover:bg-primary/5 transition-colors"
                  title="Pick the model that fuses panel answers"
                >
                  <span className="material-symbols-outlined text-[13px]">gavel</span>
                  <span className="truncate">{publicModelRef(judge) || `Auto — ${publicModelRef(combo.models[0]) || "first model"}`}</span>
                </button>
                {judge && (
                  <button
                    onClick={() => onSetStrategy({ judgeModel: "" })}
                    className="p-0.5 rounded text-text-muted hover:text-feedback-danger-foreground hover:bg-feedback-danger-surface transition-colors"
                    title="Reset judge to Auto"
                  >
                    <span className="material-symbols-outlined text-[13px]">close</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3 sm:shrink-0">
          {/* Strategy selector — always visible */}
          <div className="w-full sm:w-[200px]">
            <Select
              options={STRATEGY_OPTIONS}
              value={current}
              onChange={(e) => onSetStrategy({ fallbackStrategy: e.target.value })}
              selectClassName="py-1.5 text-xs"
            />
          </div>

          <div className="grid grid-cols-3 gap-1 sm:flex">
            <button
              onClick={(e) => { e.stopPropagation(); onCopy(combo.name, `combo-${combo.id}`); }}
              className="flex flex-col items-center rounded px-2 py-1 text-text-muted transition-colors hover:bg-muted/50 hover:text-primary"
              title="Copy combo name"
            >
              <span className="material-symbols-outlined text-[18px]">
                {copied === `combo-${combo.id}` ? "check" : "content_copy"}
              </span>
              <span className="text-[10px] leading-tight">Copy</span>
            </button>
            {onEdit && (
              <button
                onClick={onEdit}
                className="flex flex-col items-center rounded px-2 py-1 text-text-muted transition-colors hover:bg-muted/50 hover:text-primary"
                title="Edit"
              >
                <span className="material-symbols-outlined text-[18px]">edit</span>
                <span className="text-[10px] leading-tight">Edit</span>
              </button>
            )}
            {onDelete && (
              <button
                onClick={onDelete}
                className="flex flex-col items-center rounded px-2 py-1 text-feedback-danger-foreground transition-colors hover:bg-feedback-danger-surface"
                title="Delete"
              >
                <span className="material-symbols-outlined text-[18px]">delete</span>
                <span className="text-[10px] leading-tight">Delete</span>
              </button>
            )}
            {onHide && (
              <button
                onClick={onHide}
                className="flex flex-col items-center rounded px-2 py-1 text-text-muted transition-colors hover:bg-muted/50 hover:text-primary"
                title="Hide this shared combo to free its name for your own"
              >
                <span className="material-symbols-outlined text-[18px]">visibility_off</span>
                <span className="text-[10px] leading-tight">Hide</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Judge model picker (single-select; combo members make natural judges too) */}
      {showJudgeSelect && (
        <ModelSelectModal
          isOpen={showJudgeSelect}
          onClose={() => setShowJudgeSelect(false)}
          onSelect={(m) => { onSetStrategy({ judgeModel: m?.value || "" }); setShowJudgeSelect(false); }}
          activeProviders={activeProviders}
          title="Select Judge Model"
          addedModelValues={judge ? [judge] : []}
          closeOnSelect={true}
        />
      )}
    </Card>
  );
}

function CapacityAdapterSection({ capacityAdapter, onChange, activeProviders, getCaps }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">Vision Adapter</p>
          <p className="text-xs text-text-muted mt-0.5">
            Your model can&apos;t read image/audio? Auto-switches to a model in the pool below.
          </p>
          <ul className="mt-1.5 text-[11px] text-text-muted flex flex-col gap-0.5">
            <li><span className="font-medium text-text-main">Vision</span> — images (png, jpg, webp, …)</li>
            <li><span className="font-medium text-text-main">Audio</span> — audio input</li>
          </ul>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        {CAPACITY_ADAPTER_CAPS.map((cap) => (
          <CapacityAdapterCap
            key={cap.key}
            cap={cap}
            entry={capacityAdapter[cap.key] || EMPTY_CAP_ENTRY}
            onChange={(entry) => onChange({ ...capacityAdapter, [cap.key]: entry })}
            activeProviders={activeProviders}
            getCaps={getCaps}
          />
        ))}
      </div>
    </div>
  );
}

function CapacityAdapterCap({ cap, entry, onChange, activeProviders, getCaps }) {
  const [showModelSelect, setShowModelSelect] = useState(false);
  const { enabled, roundRobin, models } = entry;

  const patch = (p) => onChange({ ...entry, ...p });

  const handleAdd = (model) => {
    if (models.includes(model.value)) return;
    patch({ models: [...models, model.value] });
  };

  const handleRemove = (index) => {
    const next = models.filter((_, i) => i !== index);
    patch({ models: next.length === 0 ? [DEFAULT_FALLBACK_MODEL] : next });
  };

  const handleMove = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= models.length) return;
    const next = [...models];
    [next[index], next[target]] = [next[target], next[index]];
    patch({ models: next });
  };

  return (
    <Card padding="sm" className={`group ${!enabled ? "opacity-50" : ""}`}>
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Master toggle + icon + label + chips */}
        <div className="flex min-w-0 flex-1 items-start gap-2.5 sm:items-center">
          <Toggle
            checked={enabled}
            onChange={(v) => patch({ enabled: v })}
            aria-label={`Enable ${cap.label} adapter`}
          />
          <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-primary text-[18px]">{cap.icon}</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <code className="font-mono text-sm font-medium">{cap.label}</code>
              <span className="text-[10px] text-text-muted">— {cap.desc}</span>
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
              {models.length === 0 ? (
                <span className="text-xs text-text-muted italic">No models</span>
              ) : (
                models.slice(0, 3).map((model, index) => (
                  <code
                    key={`${model}-${index}`}
                    className="group/chip inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-text-muted"
                  >
                    <span>{publicModelRef(model)}</span>
                    <CapacityBadges caps={getCaps?.(model)} />
                    <button onClick={() => handleMove(index, -1)} disabled={index === 0} className={`leading-none opacity-0 group-hover/chip:opacity-100 ${index === 0 ? "text-text-muted/20" : "text-text-muted hover:text-primary"}`}>
                      <span className="material-symbols-outlined text-[12px]">arrow_upward</span>
                    </button>
                    <button onClick={() => handleMove(index, 1)} disabled={index === models.length - 1} className={`leading-none opacity-0 group-hover/chip:opacity-100 ${index === models.length - 1 ? "text-text-muted/20" : "text-text-muted hover:text-primary"}`}>
                      <span className="material-symbols-outlined text-[12px]">arrow_downward</span>
                    </button>
                    <button onClick={() => handleRemove(index)} className="leading-none opacity-0 group-hover/chip:opacity-100 text-text-muted hover:text-feedback-danger-foreground">
                      <span className="material-symbols-outlined text-[12px]">close</span>
                    </button>
                  </code>
                ))
              )}
              {models.length > 3 && (
                <span className="text-[10px] text-text-muted">+{models.length - 3} more</span>
              )}
            </div>
          </div>
        </div>

        {/* Actions: Round-robin toggle + Add Model */}
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3 sm:shrink-0">
          <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer select-none">
            <Toggle
              checked={roundRobin}
              onChange={(v) => patch({ roundRobin: v })}
              disabled={!enabled}
              aria-label={`Round-robin ${cap.label} adapter`}
            />
            <span>Round</span>
          </label>
          <Button
            icon="add"
            variant="ghost"
            size="sm"
            onClick={() => setShowModelSelect(true)}
            disabled={!enabled}
            title={`Add ${cap.label} model`}
          >
            Add Model
          </Button>
        </div>
      </div>

      {showModelSelect && (
        <ModelSelectModal
          isOpen={showModelSelect}
          onClose={() => setShowModelSelect(false)}
          onSelect={handleAdd}
          activeProviders={activeProviders}
          title={`Add ${cap.label} Model`}
          addedModelValues={models}
          capFilter={cap.key}
          closeOnSelect={false}
        />
      )}
    </Card>
  );
}

function ModelItem({ id, index, model, isFirst, isLast, onEdit, onMoveUp, onMoveDown, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    // no transition — prevents the CSS settle animation fighting React's re-render on drop
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 999 : undefined,
  };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(model);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== model) onEdit(trimmed);
    else setDraft(model);
    setEditing(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { setDraft(model); setEditing(false); }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 bg-muted/50 hover:bg-muted/50 transition-colors ${isDragging ? "shadow-md ring-1 ring-primary/30" : ""}`}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        type="button"
        className="cursor-grab touch-none p-0.5 rounded text-text-muted hover:text-primary active:cursor-grabbing shrink-0"
        title="Drag to reorder"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="4" r="2"/><circle cx="15" cy="4" r="2"/>
          <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
          <circle cx="9" cy="20" r="2"/><circle cx="15" cy="20" r="2"/>
        </svg>
      </button>

      {/* Index badge */}
      <span className="text-[10px] font-medium text-text-muted w-3 text-center shrink-0">{index + 1}</span>

      {/* Inline editable model value */}
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          className="min-w-0 flex-1 rounded border border-primary/40 bg-white px-1.5 py-0.5 font-mono text-xs text-text-main outline-none"
        />
      ) : (
        <div
          className="min-w-0 flex-1 cursor-text truncate rounded px-1.5 py-0.5 font-mono text-xs text-text-main hover:bg-muted/50"
          onClick={() => setEditing(true)}
          title="Click to edit"
        >
          {model}
        </div>
      )}

      {/* Priority arrows */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          onClick={onMoveUp}
          disabled={isFirst}
          className={`p-0.5 rounded ${isFirst ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-muted/50"}`}
          title="Move up"
        >
          <span className="material-symbols-outlined text-[12px]">arrow_upward</span>
        </button>
        <button
          onClick={onMoveDown}
          disabled={isLast}
          className={`p-0.5 rounded ${isLast ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-muted/50"}`}
          title="Move down"
        >
          <span className="material-symbols-outlined text-[12px]">arrow_downward</span>
        </button>
      </div>

      {/* Remove */}
      <button
        onClick={onRemove}
        className="p-0.5 hover:bg-feedback-danger-surface rounded text-text-muted hover:text-feedback-danger-foreground transition-all"
        title="Remove"
      >
        <span className="material-symbols-outlined text-[12px]">close</span>
      </button>
    </div>
  );
}

function ComboFormModal({ isOpen, combo, onClose, onSave, activeProviders, kindFilter = null, canAssignOwner = false }) {
  // Initialize state with combo values - key prop on parent handles reset on remount
  const [name, setName] = useState(combo?.name || "");
  // Members saved under a legacy short code ("cx/x") open, and save, in their readable form.
  const [models, setModels] = useState(() => (combo?.models || []).map(publicModelRef));
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [owner, setOwner] = useState(combo?.owner || "");
  const [modelAliases, setModelAliases] = useState({});

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Use stable index-based IDs so duplicates and similar names are handled correctly
  const modelItems = models.map((model, i) => ({ uid: `item-${i}`, model }));

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = modelItems.findIndex((m) => m.uid === active.id);
      const newIndex = modelItems.findIndex((m) => m.uid === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        setModels((prev) => arrayMove(prev, oldIndex, newIndex));
      }
    }
  };

  const fetchModalData = async () => {
    try {
      const aliasesRes = await fetch("/api/models/alias");
      if (!aliasesRes.ok) return;
      const aliasesData = await aliasesRes.json();
      setModelAliases(aliasesData.aliases || {});
    } catch (error) {
      console.error("Error fetching modal data:", error);
    }
  };

  useEffect(() => {
    // Legacy modal loader owns the modal's local form state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isOpen) fetchModalData();
  }, [isOpen]);

  const validateName = (value) => {
    if (!value.trim()) {
      setNameError("Name is required");
      return false;
    }
    if (!VALID_NAME_REGEX.test(value)) {
      setNameError("Only letters, numbers, -, _ and . allowed");
      return false;
    }
    setNameError("");
    return true;
  };

  const handleNameChange = (e) => {
    const value = e.target.value;
    setName(value);
    if (value) validateName(value);
    else setNameError("");
  };

  const handleAddModel = (model) => {
    if (!models.includes(model.value)) {
      setModels([...models, model.value]);
    }
  };

  const handleDeselectModel = (model) => {
    setModels(models.filter((m) => m !== model.value));
  };

  const handleRemoveModel = (index) => {
    setModels(models.filter((_, i) => i !== index));
  };

  const handleMoveUp = (index) => {
    if (index === 0) return;
    const newModels = [...models];
    [newModels[index - 1], newModels[index]] = [newModels[index], newModels[index - 1]];
    setModels(newModels);
  };

  const handleMoveDown = (index) => {
    if (index === models.length - 1) return;
    const newModels = [...models];
    [newModels[index], newModels[index + 1]] = [newModels[index + 1], newModels[index]];
    setModels(newModels);
  };

  const handleSave = async () => {
    if (!validateName(name)) return;
    setSaving(true);
    // Only an admin sends an owner; for everyone else the server stamps their own.
    await onSave({ name: name.trim(), models, ...(canAssignOwner ? { owner: owner.trim() || null } : {}) });
    setSaving(false);
  };

  const isEdit = !!combo;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={isEdit ? "Edit Combo" : "Create Combo"}
      >
        <div className="flex flex-col gap-3">
          {/* Name */}
          <div>
            <Input
              label="Combo Name"
              value={name}
              onChange={handleNameChange}
              placeholder="my-combo"
              error={nameError}
            />
            <p className="text-[10px] text-text-muted mt-0.5">
              Only letters, numbers, -, _ and . allowed
            </p>
          </div>

          {canAssignOwner && (
            <div>
              <Input
                label="Owner"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder="user@company.com"
              />
              <p className="text-[10px] text-text-muted mt-0.5">
                Leave empty to share with everyone (read-only for them), or use &ldquo;@admin&rdquo; to
                keep it to the password login.
              </p>
            </div>
          )}

          {/* Models */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">Models</label>

            {models.length === 0 ? (
              <div className="text-center py-4 border border-dashed border-muted rounded-lg bg-muted/50">
                <span className="material-symbols-outlined text-text-muted text-xl mb-1">layers</span>
                <p className="text-xs text-text-muted">No models added yet</p>
              </div>
            ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
              <SortableContext items={modelItems.map((m) => m.uid)} strategy={verticalListSortingStrategy}>
                <div className="flex max-h-[55vh] min-w-0 flex-col gap-1 overflow-y-auto sm:max-h-[350px]">
                  {modelItems.map(({ uid, model }, index) => (
                    <ModelItem
                      key={uid}
                      id={uid}
                      index={index}
                      model={model}
                      isFirst={index === 0}
                      isLast={index === modelItems.length - 1}
                      onEdit={(newVal) => {
                        const updated = [...models];
                        updated[index] = newVal;
                        setModels(updated);
                      }}
                      onMoveUp={() => handleMoveUp(index)}
                      onMoveDown={() => handleMoveDown(index)}
                      onRemove={() => handleRemoveModel(index)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            )}

            {/* Add Model button */}
            <button
              onClick={() => setShowModelSelect(true)}
              className="w-full mt-2 py-2 border border-dashed border-muted rounded-lg text-xs text-primary font-medium hover:text-primary hover:border-primary/50 transition-colors flex items-center justify-center gap-1"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add Model
            </button>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Button onClick={onClose} variant="ghost" fullWidth size="sm">
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              fullWidth
              size="sm"
              disabled={!name.trim() || !!nameError || saving}
            >
              {saving ? "Saving..." : isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Model Select Modal */}
      {showModelSelect && (
        <ModelSelectModal
          isOpen={showModelSelect}
          onClose={() => setShowModelSelect(false)}
          onSelect={handleAddModel}
          onDeselect={handleDeselectModel}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Add Model to Combo"
          kindFilter={kindFilter}
          addedModelValues={models}
          closeOnSelect={false}
        />
      )}
    </>
  );
}
