"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  Button,
  Checkbox,
  Input,
  Modal,
  SegmentedControl,
  Select,
  TALL_MODAL_PROPS,
  Toggle,
} from "@/shared/components";
import {
  errorText,
  SECRET_PLACEHOLDER,
  WINDOW_SIZES_SEC,
  type FieldDescriptor,
  type KeyRef,
  type TestResult,
  type TransportDescriptor,
  type UsageSink,
} from "../types";
import { ApiKeyPicker } from "./ApiKeyPicker";
import { TestResultPanel } from "./TestResultPanel";

type FormValues = Record<string, string | boolean>;

function initialValues(descriptor: TransportDescriptor | undefined, sink: UsageSink | null) {
  const values: FormValues = {};
  for (const field of descriptor?.fields ?? []) {
    const stored = sink?.config?.[field.key];
    if (field.type === "boolean") values[field.key] = stored === true;
    else if (field.secret) values[field.key] = "";
    else if (Array.isArray(stored)) values[field.key] = stored.join(", ");
    else values[field.key] = stored === undefined || stored === null ? "" : String(stored);
  }
  return values;
}

/** Fields that only apply once a SASL mechanism is chosen. */
const SASL_DETAIL_FIELDS = new Set(["saslUsername", "saslPassword"]);

function newSigningSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `whsec_${btoa(String.fromCharCode(...bytes))}`;
}

interface SinkFormProps {
  types: TransportDescriptor[];
  sink: UsageSink | null;
  onClose: () => void;
  onSaved: () => void;
}

function SinkForm({ types, sink, onClose, onSaved }: SinkFormProps) {
  const t = useTranslations("usageSinks");
  const [name, setName] = useState(sink?.name ?? "");
  const [typeId, setTypeId] = useState(sink?.type ?? types[0]?.type ?? "webhook");
  const [values, setValues] = useState<FormValues>(() => {
    const initial = initialValues(
      types.find((type) => type.type === (sink?.type ?? types[0]?.type)),
      sink
    );
    if (!sink && (types[0]?.type ?? "webhook") === "webhook") initial.secret = newSigningSecret();
    return initial;
  });
  // Optional credentials the operator chose to remove on this edit.
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"instant" | "window">(sink?.mode ?? "window");
  const [windowSec, setWindowSec] = useState(String(sink?.windowSec ?? 900));
  const [keyScope, setKeyScope] = useState<"all" | "selected">(
    sink?.apiKeyIds.length ? "selected" : "all"
  );
  const [selectedKeys, setSelectedKeys] = useState<KeyRef[]>(sink?.filterKeys ?? []);
  const [enabled, setEnabled] = useState(sink?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const descriptor = types.find((type) => type.type === typeId);
  const setValue = (key: string, value: string | boolean) =>
    setValues((current) => ({ ...current, [key]: value }));

  const changeType = (next: string) => {
    setTypeId(next);
    setCleared(new Set());
    const fresh = initialValues(
      types.find((type) => type.type === next),
      null
    );
    if (next === "webhook") fresh.secret = newSigningSecret();
    setValues(fresh);
  };

  const hasStored = (field: FieldDescriptor) =>
    Boolean(sink && field.secret && sink.config[field.key] === SECRET_PLACEHOLDER);

  const buildConfig = (): Record<string, unknown> => {
    const config: Record<string, unknown> = {};
    for (const field of descriptor?.fields ?? []) {
      const value = values[field.key];
      if (field.type === "boolean") {
        config[field.key] = Boolean(value);
      } else if (field.secret) {
        const text = typeof value === "string" ? value : "";
        if (text) config[field.key] = text;
        else if (cleared.has(field.key)) config[field.key] = "";
        else if (hasStored(field)) config[field.key] = SECRET_PLACEHOLDER;
      } else {
        const text = typeof value === "string" ? value.trim() : "";
        if (text) config[field.key] = text;
      }
    }
    return config;
  };

  const schedule = () => ({
    mode,
    ...(mode === "window" ? { windowSec: Number(windowSec) } : {}),
  });

  const save = async () => {
    if (keyScope === "selected" && selectedKeys.length === 0) {
      setError(t("pickAKey"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const shared = {
        name: name.trim(),
        config: buildConfig(),
        ...schedule(),
        apiKeyIds: keyScope === "selected" ? selectedKeys.map((key) => key.id) : [],
        enabled,
      };
      const res = await fetch(sink ? `/api/usage-sinks/${sink.id}` : "/api/usage-sinks", {
        method: sink ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sink ? shared : { ...shared, type: typeId }),
      });
      if (res.ok) return onSaved();
      setError(
        errorText(await res.json().catch(() => ({})), t("saveFailed", { status: res.status }))
      );
    } finally {
      setSaving(false);
    }
  };

  // Testing an unsaved sink needs somewhere to send from: new sinks are tested after saving.
  const test = async () => {
    if (!sink) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/usage-sinks/${sink.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: buildConfig(), ...schedule() }),
      });
      const data = await res.json().catch(() => ({}));
      setTestResult(
        res.ok
          ? data
          : { valid: false, error: errorText(data, t("saveFailed", { status: res.status })) }
      );
    } finally {
      setTesting(false);
    }
  };

  const renderField = (field: FieldDescriptor) => {
    if (SASL_DETAIL_FIELDS.has(field.key) && !values.saslMechanism) return null;
    const value = values[field.key];
    const label = `${field.labelFallback}${field.required ? " *" : ""}`;
    if (field.type === "boolean") {
      return (
        <Checkbox
          key={field.key}
          label={field.labelFallback}
          checked={Boolean(value)}
          onChange={(event) => setValue(field.key, event.target.checked)}
        />
      );
    }
    if (field.type === "select") {
      return (
        <Select
          key={field.key}
          label={field.labelFallback}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => setValue(field.key, event.target.value)}
          options={(field.options ?? []).map((option) => ({
            value: option.value,
            label: option.labelFallback,
          }))}
        />
      );
    }
    const stored = hasStored(field) && !cleared.has(field.key);
    const isWebhookSecret = typeId === "webhook" && field.key === "secret";
    return (
      <div key={field.key} className="flex flex-col gap-1.5">
        <div className="flex items-end gap-2">
          <Input
            className="min-w-0 flex-1"
            inputClassName={field.secret ? "font-mono" : undefined}
            label={label}
            // A freshly generated signing secret is shown so it can be copied: it is never shown again.
            type={field.secret && !(isWebhookSecret && value) ? "password" : "text"}
            autoComplete="off"
            value={typeof value === "string" ? value : ""}
            onChange={(event) => setValue(field.key, event.target.value)}
            placeholder={stored ? t("keepStored") : field.placeholder}
            hint={field.helpFallback}
          />
          {isWebhookSecret ? (
            <Button
              variant="secondary"
              icon="key"
              className="shrink-0"
              onClick={() => setValue(field.key, newSigningSecret())}
            >
              {t("generate")}
            </Button>
          ) : null}
          {field.secret && !field.required && stored ? (
            <Button
              variant="ghost"
              className="shrink-0"
              onClick={() => setCleared(new Set(cleared).add(field.key))}
            >
              {t("removeStored")}
            </Button>
          ) : null}
        </div>
        {field.secret && cleared.has(field.key) ? (
          <p className="text-xs text-text-muted">{t("willBeRemoved")}</p>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label={t("fieldName")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("namePlaceholder")}
        />
        <Select
          label={t("fieldSendTo")}
          value={typeId}
          onChange={(event) => changeType(event.target.value)}
          options={types.map((type) => ({ value: type.type, label: type.label }))}
          disabled={Boolean(sink)}
        />
      </div>
      {descriptor ? <p className="text-xs text-text-muted">{descriptor.description}</p> : null}
      {(descriptor?.fields ?? []).map(renderField)}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label={t("fieldWhatToSend")}
          value={mode}
          onChange={(event) => setMode(event.target.value === "instant" ? "instant" : "window")}
          options={[
            { value: "window", label: t("modeWindow") },
            { value: "instant", label: t("modeInstant") },
          ]}
        />
        {mode === "window" ? (
          <Select
            label={t("fieldWindow")}
            value={windowSec}
            onChange={(event) => setWindowSec(event.target.value)}
            options={WINDOW_SIZES_SEC.map((seconds) => ({
              value: String(seconds),
              label: t("windowEvery", { minutes: seconds / 60 }),
            }))}
          />
        ) : null}
      </div>

      <fieldset className="flex flex-col gap-3 border-t border-border pt-4">
        <legend className="sr-only">{t("apiKeys")}</legend>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-text-main">{t("apiKeys")}</span>
          <SegmentedControl
            size="sm"
            aria-label={t("apiKeys")}
            value={keyScope}
            onChange={(value) => setKeyScope(value === "selected" ? "selected" : "all")}
            options={[
              { value: "all", label: t("allKeys") },
              { value: "selected", label: t("selectedKeys") },
            ]}
          />
        </div>
        {keyScope === "all" ? (
          <p className="text-xs text-text-muted">{t("allKeysHint")}</p>
        ) : (
          <ApiKeyPicker selected={selectedKeys} onChange={setSelectedKeys} />
        )}
      </fieldset>

      <Toggle
        checked={enabled}
        onChange={setEnabled}
        label={t("fieldEnabled")}
        description={t("fieldEnabledHint")}
      />

      {error ? (
        <p
          className="rounded-md border border-feedback-danger-border bg-feedback-danger-surface px-3 py-2 text-sm text-feedback-danger-foreground"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <TestResultPanel result={testResult} />

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          {t("cancel")}
        </Button>
        {sink ? (
          <Button variant="secondary" icon="send" onClick={() => void test()} loading={testing}>
            {t("sendTest")}
          </Button>
        ) : null}
        <Button onClick={() => void save()} loading={saving} disabled={!name.trim()}>
          {sink ? t("save") : t("addSink")}
        </Button>
      </div>
    </div>
  );
}

interface SinkFormModalProps extends SinkFormProps {
  open: boolean;
}

export function SinkFormModal({ open, ...formProps }: SinkFormModalProps) {
  const t = useTranslations("usageSinks");
  return (
    <Modal
      isOpen={open}
      onClose={formProps.onClose}
      size="lg"
      title={formProps.sink ? t("editSink") : t("addSink")}
      {...TALL_MODAL_PROPS}
    >
      {open ? <SinkForm key={formProps.sink?.id ?? "new"} {...formProps} /> : null}
    </Modal>
  );
}
