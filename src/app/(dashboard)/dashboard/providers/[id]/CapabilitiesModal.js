"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal, Select } from "@/shared/components";

const FLAGS = [
  { key: "vision", label: "Reads images" },
  { key: "pdf", label: "Reads PDFs" },
  { key: "tools", label: "Tool calling" },
  { key: "reasoning", label: "Reasoning / thinking" },
  { key: "thinkingCanDisable", label: "Thinking can be turned off" },
  { key: "forcedToolChoice", label: "Accepts a forced tool_choice" },
  { key: "search", label: "Built-in web search" },
];
const LIMITS = [
  { key: "contextWindow", label: "Context window (tokens)" },
  { key: "maxOutput", label: "Max output (tokens)" },
];
// "" keeps what RedRouter already believes; yes/no overrides it.
const FLAG_OPTIONS = [
  { value: "", label: "Default" },
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];

/**
 * Correct what RedRouter believes a model can do. The override wins over every
 * built-in table and the synced catalog, for routing, /v1/models and `parameters`.
 */
export default function CapabilitiesModal({ isOpen, provider, model, onClose }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isOpen || !model) return;
    let cancelled = false;
    fetch(`/api/models/capabilities?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return;
        const override = json.override || {};
        setData(json);
        setForm(Object.fromEntries([
          ...FLAGS.map(({ key }) => [key, typeof override[key] === "boolean" ? String(override[key]) : ""]),
          ...LIMITS.map(({ key }) => [key, override[key] ?? ""]),
        ]));
        setError("");
      })
      .catch(() => { if (!cancelled) setError("Could not load capabilities"); });
    return () => { cancelled = true; };
  }, [isOpen, provider, model]);

  const save = async (clear = false) => {
    setSaving(true);
    setError("");
    try {
      const capabilities = clear ? null : Object.fromEntries([
        ...FLAGS.filter(({ key }) => form[key] !== "").map(({ key }) => [key, form[key] === "true"]),
        ...LIMITS.filter(({ key }) => form[key] !== "").map(({ key }) => [key, Number(form[key])]),
      ]);
      const res = await fetch("/api/models/capabilities", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model, capabilities }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed to save");
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const base = data?.base || {};
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Capabilities · ${model || ""}`}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-text-muted">
          Leave a field on Default to keep RedRouter&apos;s value (shown on the right). Overrides apply to routing, /v1/models and the model&apos;s parameters.
        </p>
        {FLAGS.map(({ key, label }) => (
          <div key={key} className="flex items-center justify-between gap-3">
            <span className="text-sm">{label} <span className="text-xs text-text-muted">(default: {base[key] ? "yes" : "no"})</span></span>
            <Select
              options={FLAG_OPTIONS}
              value={form[key] ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
              className="w-32"
            />
          </div>
        ))}
        {LIMITS.map(({ key, label }) => (
          <Input
            key={key}
            type="number"
            min="1"
            label={`${label} — default ${base[key]?.toLocaleString?.() ?? "?"}`}
            value={form[key] ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
            placeholder="Default"
          />
        ))}
        {error && <p className="text-sm text-[var(--reddb-color-feedback-danger-foreground)]">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => save(true)} disabled={saving}>Reset to default</Button>
          <Button onClick={() => save(false)} disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
        </div>
      </div>
    </Modal>
  );
}

CapabilitiesModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  provider: PropTypes.string.isRequired,
  model: PropTypes.string,
  onClose: PropTypes.func.isRequired,
};
