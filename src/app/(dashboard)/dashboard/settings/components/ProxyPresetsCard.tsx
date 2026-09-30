"use client";

import { CircleAlert, CircleCheck, ExternalLink, Network, Plus, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import Icon from "@/shared/components/Icon";
import { Badge, Button, Card, Input, Modal, Select, Toggle } from "@/shared/components";

/** Shapes returned by GET /api/settings/proxy-presets. Descriptors only, never a credential. */
type ParamOption = { value: string; label: string };
type ParamDescriptor = {
  name: string;
  label: string;
  type: "text" | "password" | "select" | "toggle";
  required: boolean;
  help: string;
  placeholder?: string;
  options?: ParamOption[];
  defaultValue?: string | boolean;
  pattern?: string;
  patternHint?: string;
  dependsOn?: string;
};
type Preset = {
  id: string;
  label: string;
  kind: "tor" | "residential";
  description: string;
  defaultName: string;
  verified: boolean;
  verificationNote: string;
  docsUrl: string | null;
  warnings: string[];
  params: ParamDescriptor[];
};

type FormValues = Record<string, string | boolean>;
type NoticeTone = "success" | "warning" | "danger";
type Notice = { tone: NoticeTone; message: ReactNode };

const NOTICE_CLASS: Record<NoticeTone, string> = {
  success:
    "border-feedback-success-border bg-feedback-success-surface text-feedback-success-foreground",
  warning:
    "border-feedback-warning-border bg-feedback-warning-surface text-feedback-warning-foreground",
  danger:
    "border-feedback-danger-border bg-feedback-danger-surface text-feedback-danger-foreground",
};

const NOTICE_ICON = {
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
} as const;

function InlineNotice({ tone, children }: { tone: NoticeTone; children: ReactNode }) {
  return (
    <div
      role={tone === "success" ? "status" : "alert"}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${NOTICE_CLASS[tone]}`}
    >
      <Icon icon={NOTICE_ICON[tone]} size="md" color="current" className="mt-0.5" />
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

function errorText(data: unknown): string | null {
  const error = (data as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message : null;
}

function initialValues(preset: Preset): FormValues {
  const values: FormValues = {};
  for (const param of preset.params) {
    if (param.defaultValue !== undefined) values[param.name] = param.defaultValue;
    else values[param.name] = param.type === "toggle" ? false : "";
  }
  return values;
}

/** Client-side mirror of the server checks so obvious mistakes never leave the form. */
function validate(preset: Preset, name: string, values: FormValues): string | null {
  if (!name.trim()) return "Give the proxy a name.";
  for (const param of preset.params) {
    if (param.dependsOn && values[param.dependsOn] !== true) continue;
    const value = values[param.name];
    if (param.type === "toggle") continue;
    const text = typeof value === "string" ? value.trim() : "";
    if (param.required && !text) return `${param.label} is required.`;
    if (text && param.pattern && param.type === "text") {
      try {
        if (!new RegExp(param.pattern).test(text)) {
          return param.patternHint ?? `${param.label} has an invalid format.`;
        }
      } catch {
        /* an unparsable pattern is left to the server */
      }
    }
  }
  return null;
}

/** Only params the preset declares are sent, and dependent params only while their toggle is on. */
function paramsPayload(preset: Preset, values: FormValues): Record<string, string | boolean> {
  const payload: Record<string, string | boolean> = {};
  for (const param of preset.params) {
    if (param.dependsOn && values[param.dependsOn] !== true) continue;
    const value = values[param.name];
    if (value === undefined) continue;
    if (typeof value === "string" && value.trim() === "" && !param.required) continue;
    payload[param.name] = typeof value === "string" ? value.trim() : value;
  }
  return payload;
}

const BASE = "/api/settings/proxy-presets";

/**
 * Egress proxy presets: add Tor or a residential proxy provider to the registry in two clicks.
 * The composed login is stored like any hand-typed proxy; assign it to providers or connections in
 * the registry above.
 */
export default function ProxyPresetsCard() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [active, setActive] = useState<Preset | null>(null);
  const [name, setName] = useState("");
  const [values, setValues] = useState<FormValues>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(BASE, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { items?: Preset[] } | null;
      if (!res.ok || !Array.isArray(data?.items)) {
        setUnavailable(true);
      } else {
        setPresets(data.items);
        setUnavailable(false);
      }
    } catch {
      setUnavailable(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    return () => clearTimeout(first);
  }, [load]);

  const openPreset = (preset: Preset) => {
    setActive(preset);
    setName(preset.defaultName);
    setValues(initialValues(preset));
    setFormError(null);
    setNotice(null);
  };

  const closeModal = () => {
    if (saving) return;
    setActive(null);
    // Secrets never outlive the form.
    setValues({});
  };

  const setValue = (paramName: string, value: string | boolean) =>
    setValues((current) => ({ ...current, [paramName]: value }));

  const submit = async () => {
    if (!active) return;
    const problem = validate(active, name, values);
    if (problem) {
      setFormError(problem);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch(BASE, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          presetId: active.id,
          name: name.trim(),
          params: paramsPayload(active, values),
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        action?: string;
        sticky?: boolean;
        proxy?: { name?: string };
      } | null;
      if (!res.ok) {
        setFormError(errorText(data) ?? "Could not add the proxy.");
        return;
      }
      const label = data?.proxy?.name ?? name.trim();
      const verb = data?.action === "updated" ? "updated (it already existed)" : "added";
      setNotice({
        tone: "success",
        message: (
          <>
            Proxy &ldquo;{label}&rdquo; {verb}
            {data?.sticky ? " with a sticky session" : ""}. Assign it to providers or connections in
            the proxy registry above (reload the list to see it), then use the registry&rsquo;s test
            to check that it connects.
          </>
        ),
      });
      setActive(null);
      setValues({});
    } catch {
      setFormError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padding="md">
      <div className="flex items-start gap-3">
        <Icon icon={Network} size="md" color="current" className="mt-1" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Proxy presets</h3>
          <p className="text-xs text-ink-muted">
            Add Tor or a residential proxy provider to the registry without typing the gateway and
            the login format by hand. You can edit the generated proxy afterwards.
          </p>
        </div>
      </div>

      {notice && (
        <div className="mt-3">
          <InlineNotice tone={notice.tone}>{notice.message}</InlineNotice>
        </div>
      )}

      {loaded && unavailable && (
        <p className="mt-4 text-sm text-ink-muted">Proxy presets are not available right now.</p>
      )}

      {presets.length > 0 && (
        <ul className="mt-4 divide-y divide-border/30 border-t border-border/30">
          {presets.map((preset) => (
            <li key={preset.id} className="py-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{preset.label}</span>
                    <Badge variant={preset.kind === "tor" ? "info" : "default"} size="sm">
                      {preset.kind === "tor" ? "Local" : "Residential"}
                    </Badge>
                    {!preset.verified && (
                      <Badge variant="warning" size="sm">
                        Unverified
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-ink-muted">{preset.description}</p>
                  {!preset.verified && (
                    <p className="mt-1 text-xs text-ink-muted">
                      {preset.verificationNote}
                      {preset.docsUrl && (
                        <>
                          {" "}
                          <a
                            href={preset.docsUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 underline"
                          >
                            Vendor docs
                            <Icon icon={ExternalLink} size="sm" color="current" />
                          </a>
                        </>
                      )}
                    </p>
                  )}
                </div>
                <Button size="sm" variant="secondary" onClick={() => openPreset(preset)}>
                  <Icon icon={Plus} size="sm" color="current" />
                  Add
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        isOpen={active !== null}
        title={active ? `Add ${active.label}` : "Add proxy preset"}
        onClose={closeModal}
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" disabled={saving} onClick={closeModal}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void submit()}>
              Add proxy
            </Button>
          </div>
        }
      >
        {active && (
          <div className="flex flex-col gap-4">
            {active.warnings.map((warning) => (
              <InlineNotice key={warning} tone="warning">
                {warning}
              </InlineNotice>
            ))}
            <Input
              label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              disabled={saving}
            />
            {active.params.map((param) => {
              if (param.dependsOn && values[param.dependsOn] !== true) return null;
              const value = values[param.name];
              if (param.type === "toggle") {
                return (
                  <div key={param.name} className="flex flex-col gap-1">
                    <Toggle
                      label={param.label}
                      checked={value === true}
                      onChange={(checked) => setValue(param.name, checked)}
                      disabled={saving}
                    />
                    <p className="text-xs text-ink-muted">{param.help}</p>
                  </div>
                );
              }
              if (param.type === "select") {
                return (
                  <Select
                    key={param.name}
                    label={param.label}
                    value={typeof value === "string" ? value : ""}
                    options={param.options ?? []}
                    onChange={(event) => setValue(param.name, event.target.value)}
                    hint={param.help}
                    required={param.required}
                    disabled={saving}
                  />
                );
              }
              return (
                <Input
                  key={param.name}
                  label={param.label}
                  type={param.type === "password" ? "password" : "text"}
                  value={typeof value === "string" ? value : ""}
                  onChange={(event) => setValue(param.name, event.target.value)}
                  placeholder={param.placeholder}
                  hint={param.help}
                  required={param.required}
                  autoComplete={param.type === "password" ? "new-password" : "off"}
                  spellCheck={false}
                  disabled={saving}
                />
              );
            })}
            {formError && <InlineNotice tone="danger">{formError}</InlineNotice>}
          </div>
        )}
      </Modal>
    </Card>
  );
}
