"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card, Toggle } from "@/shared/components";

const FLAG = "OMNIROUTE_DISABLE_THINKING_LEVEL_VARIANTS";
const ENDPOINT = "/api/settings/feature-flags";

function aliasesVisible(value: unknown): boolean {
  if (typeof value !== "string") throw new Error("Missing catalog setting");
  return !["true", "1", "yes"].includes(value);
}

export default function ModelEffortCatalogTab() {
  const [showAliases, setShowAliases] = useState(false);
  const [saved, setSaved] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const saveController = useRef<AbortController | null>(null);

  useEffect(() => () => saveController.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    fetch(ENDPOINT, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load catalog settings");
        return response.json();
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        const flag = data.flags?.find((entry: { key: string }) => entry.key === FLAG);
        const visible = aliasesVisible(flag?.effectiveValue);
        setShowAliases(visible);
        setSaved(visible);
        setError("");
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Unable to load catalog settings. Retry loading.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);

  async function save() {
    if (loading || saving || saved === null) return;
    const controller = new AbortController();
    saveController.current = controller;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(ENDPOINT, {
        method: "PUT",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: FLAG, value: showAliases ? "false" : "true" }),
      });
      if (!response.ok) throw new Error("Unable to save catalog settings");
      const data = await response.json();
      if (controller.signal.aborted) return;
      const visible = aliasesVisible(data.effectiveValue);
      setShowAliases(visible);
      setSaved(visible);
      setMessage("Saved. Refresh your client's model list to see the change.");
    } catch {
      if (!controller.signal.aborted) {
        setError("Unable to save catalog settings. Your change is still here; retry saving.");
      }
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return (
    <Card
      title="Models and reasoning effort"
      subtitle="Select the base model and send reasoning effort separately. Supported levels are listed in each model's capabilities.effort_tiers."
    >
      <div className="space-y-4">
        <p className="text-sm text-text-muted max-w-prose">
          Chat Completions uses <code>reasoning_effort</code>; Responses uses{" "}
          <code>reasoning.effort</code>. Anthropic Messages uses <code>output_config.effort</code>{" "}
          and <code>thinking</code> for supported thinking modes. Levels and modes depend on the
          model.
        </p>
        <Toggle
          label="Show effort aliases for older clients"
          description="List extra names such as model-high for clients that choose effort through the model picker. Existing aliases remain accepted when hidden. Native upstream model IDs are kept."
          checked={showAliases}
          disabled={loading || saving || saved === null}
          onChange={(value) => {
            setShowAliases(value);
            setMessage("");
          }}
        />
        {loading && (
          <p role="status" className="text-sm text-text-muted">
            Loading catalog settings…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-500">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm text-text-muted">
            {message}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            onClick={() => void save()}
            loading={saving}
            disabled={loading || saving || saved === null || showAliases === saved}
          >
            Save catalog settings
          </Button>
          {!loading && saved === null && (
            <Button
              variant="secondary"
              onClick={() => {
                setLoading(true);
                setError("");
                setRevision((value) => value + 1);
              }}
            >
              Retry loading
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
