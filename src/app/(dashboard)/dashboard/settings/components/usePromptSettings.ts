"use client";

import { useEffect, useState } from "react";

export function usePromptSettings<T extends object>(
  endpoint: string,
  method: "PUT" | "PATCH",
  read: (data: Record<string, unknown>) => T
) {
  const [config, setConfig] = useState<T | null>(null);
  const [saved, setSaved] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load prompt settings.");
        const data = await response.json();
        if (!data || typeof data !== "object" || Array.isArray(data))
          throw new Error("Unable to load prompt settings.");
        if (controller.signal.aborted) return;
        const value = read(data);
        setConfig(value);
        setSaved(value);
        setError("");
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Unable to load prompt settings. Retry the request.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint, read, revision]);

  const edit = (updates: Partial<T>) => {
    setConfig((current) => (current ? { ...current, ...updates } : current));
    setMessage("");
  };
  const save = async () => {
    if (!config || loading || saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!response.ok) throw new Error("Unable to save prompt settings.");
      setSaved(config);
      setMessage("Saved.");
    } catch {
      setError("Unable to save prompt settings. Your edits are still here; retry saving.");
    } finally {
      setSaving(false);
    }
  };
  const retry = () => {
    setLoading(true);
    setError("");
    setRevision((value) => value + 1);
  };

  return {
    config,
    edit,
    save,
    retry,
    error,
    message,
    saving,
    loading,
    disabled: loading || saving || !config,
    dirty: config !== null && JSON.stringify(config) !== JSON.stringify(saved),
  };
}
