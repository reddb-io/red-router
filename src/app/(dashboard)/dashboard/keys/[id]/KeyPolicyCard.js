"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Card, Button, Input, Select, Toggle } from "@/shared/components";

const MODE_OPTIONS = [
  { value: "all", label: "Every model" },
  { value: "allow", label: "Only matching models" },
  { value: "deny", label: "Every model except matching" },
];

const ID_FORMAT_OPTIONS = [
  { value: "prefixed", label: "Every offer, with its provider (openrouter/anthropic/…)" },
  { value: "flat", label: "One per model, RedRouter picks the provider (anthropic/claude-…)" },
];

const LIMIT_FIELDS = [
  { key: "rpm", label: "Requests per minute", placeholder: "No limit", step: "1" },
  { key: "tokensPerDay", label: "Tokens per day", placeholder: "No limit", step: "1" },
  { key: "usdPerMonth", label: "Spend per month (USD)", placeholder: "No limit", step: "0.01" },
];

function formFromKey(apiKey) {
  const access = apiKey?.modelAccess;
  const limits = apiKey?.limits || {};
  return {
    mode: access?.mode || "all",
    patterns: (access?.patterns || []).join("\n"),
    rpm: limits.rpm ?? "",
    tokensPerDay: limits.tokensPerDay ?? "",
    usdPerMonth: limits.usdPerMonth ?? "",
    modelIdFormat: apiKey?.modelIdFormat === "flat" ? "flat" : "prefixed",
    mcpManageKeys: apiKey?.mcpManageKeys === true,
  };
}

/** Model rules and usage limits of one API key. */
export default function KeyPolicyCard({ apiKey, onSaved }) {
  const [form, setForm] = useState(() => formFromKey(apiKey));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [requireApiKey, setRequireApiKey] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((settings) => { if (!cancelled && settings) setRequireApiKey(settings.requireApiKey === true); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const update = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const patterns = form.patterns.split(/[\n,]/).map((p) => p.trim()).filter(Boolean);
      const limits = Object.fromEntries(LIMIT_FIELDS.map(({ key }) => [key, form[key] === "" ? null : Number(form[key])]));
      const response = await fetch(`/api/keys/${apiKey.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelAccess: form.mode === "all" ? null : { mode: form.mode, patterns },
          limits,
          modelIdFormat: form.modelIdFormat,
          mcpManageKeys: form.mcpManageKeys,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to save");
      onSaved(data.key);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }, [apiKey.id, form, onSaved]);

  return (
    <Card padding="lg">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-text-primary">Models and limits</h2>
          <p className="mt-1 text-sm text-text-muted">
            Which models this key may call and how much it may use. Over a limit, requests get HTTP 429 with Retry-After.
          </p>
        </div>
        <Button icon="save" onClick={save} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

      {!requireApiKey && (
        <p className="mt-3 rounded-lg bg-feedback-warning-surface px-3 py-2 text-xs text-feedback-warning-foreground">
          &quot;Require API key&quot; is off, so requests sent without a key skip these rules and limits.
        </p>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <Select label="Models" options={MODE_OPTIONS} value={form.mode} onChange={update("mode")} />
          {form.mode !== "all" && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-main" htmlFor="model-patterns">Patterns</label>
              <textarea
                id="model-patterns"
                value={form.patterns}
                onChange={update("patterns")}
                rows={5}
                placeholder={"claude-code/claude-*\nopenai/gpt-5*\nmy-combo"}
                className="w-full rounded-md bg-surface-2 px-3 py-2.5 font-mono text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              />
              <p className="text-xs text-text-muted">
                One per line. <code>*</code> matches anything, <code>?</code> one character; case does not matter.
                A pattern matches a model under any of its provider prefixes and aliases. Allowing a combo allows the models it calls.
              </p>
            </div>
          )}
          <Select label="Model ids in /v1/models" options={ID_FORMAT_OPTIONS} value={form.modelIdFormat} onChange={update("modelIdFormat")} />
          {form.modelIdFormat === "flat" && (
            <p className="text-xs text-text-muted">
              One entry per model, cheapest provider first and the next on failure. Free and paid offers, and different
              versions, stay separate entries. Ids with a provider keep working to pin one offer.
            </p>
          )}
          <Toggle
            checked={form.mcpManageKeys}
            onChange={(checked) => setForm((prev) => ({ ...prev, mcpManageKeys: checked }))}
            label="Manage API keys via MCP"
            description="Through /v1/mcp this key may list API keys, read their usage and create new ones (never with this permission). Off: it only sees itself."
          />
        </div>
        <div className="flex flex-col gap-3">
          {LIMIT_FIELDS.map(({ key, label, placeholder, step }) => (
            <Input
              key={key}
              label={label}
              type="number"
              min="0"
              step={step}
              value={form[key]}
              onChange={update(key)}
              placeholder={placeholder}
            />
          ))}
          <p className="text-xs text-text-muted">Days and months follow this server&apos;s local time. Leave a field empty for no limit.</p>
        </div>
      </div>
      {error && <p className="mt-3 text-sm text-feedback-danger-foreground">{error}</p>}
    </Card>
  );
}

KeyPolicyCard.propTypes = {
  apiKey: PropTypes.shape({
    id: PropTypes.string.isRequired,
    modelAccess: PropTypes.object,
    limits: PropTypes.object,
  }).isRequired,
  onSaved: PropTypes.func.isRequired,
};
