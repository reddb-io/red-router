"use client";

import { CircleCheck } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Badge, Button, Card, Input, RecommendedSetup, Select } from "@/shared/components";
import { useDisplayBaseUrl } from "@/shared/hooks";

interface SetupConnection {
  id: string;
  provider?: string;
  name?: string;
  displayName?: string;
  isActive?: boolean;
}

interface SetupKey {
  id?: string;
  isActive?: boolean;
  isBanned?: boolean;
}

interface CreatedKey extends SetupKey {
  key?: string;
}

interface ValidationCheck {
  id: string;
  status: "pass" | "fail";
  message: string;
}

interface Validation {
  status: "ready" | "action_required" | "error";
  checks?: ValidationCheck[];
}

const EMPTY: { connections: SetupConnection[]; keys: SetupKey[] } = { connections: [], keys: [] };

function StepStatus({ done, active }: { done: boolean; active: boolean }) {
  const t = useTranslations("setup");
  const icon = done ? "check" : active ? "arrow_forward" : "more_horiz";
  const tone = done
    ? "border-feedback-success-border bg-feedback-success-surface text-feedback-success-foreground"
    : active
      ? "border-primary text-primary"
      : "border-border text-text-muted";
  return (
    <span
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${tone}`}
      role="img"
      aria-label={done ? t("stepComplete") : active ? t("stepCurrent") : t("stepPending")}
    >
      <span className="material-symbols-outlined text-[length:var(--reddb-spatial-icon-size-sm)] leading-none">
        {icon}
      </span>
    </span>
  );
}

function StepLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
    >
      {children}
      <span aria-hidden="true">→</span>
    </Link>
  );
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * The guided setup: connect a provider, create an API key, copy the client
 * configuration, validate the whole route and organize the recommended combos.
 */
export default function SetupWorkbench() {
  const t = useTranslations("setup");
  const baseUrl = useDisplayBaseUrl();
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [keyName, setKeyName] = useState(() => t("keyDefaultName"));
  const [creatingKey, setCreatingKey] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreatedKey | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [validating, setValidating] = useState(false);
  const [copied, setCopied] = useState("");
  const [organized, setOrganized] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [providersResponse, keysResponse] = await Promise.all([
        fetch("/api/providers", { cache: "no-store" }),
        fetch("/api/keys", { cache: "no-store" }),
      ]);
      if (!providersResponse.ok || !keysResponse.ok) throw new Error(t("statusUnavailable"));
      const [providers, keys] = await Promise.all([
        readJson(providersResponse),
        readJson(keysResponse),
      ]);
      const connections = (providers.connections as SetupConnection[] | undefined) || [];
      setData({ connections, keys: (keys.keys as SetupKey[] | undefined) || [] });
      setSelectedConnectionId(
        (current) =>
          current ||
          connections.find((item) => item.isActive !== false)?.id ||
          connections[0]?.id ||
          ""
      );
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    queueMicrotask(load);
  }, [load]);

  const activeConnections = useMemo(
    () => data.connections.filter((item) => item.isActive !== false),
    [data.connections]
  );
  const hasProvider = activeConnections.length > 0;
  const hasKey =
    data.keys.some((item) => item.isActive !== false && item.isBanned !== true) || !!createdKey;
  const isReady = validation?.status === "ready";
  const configCopied = copied === "snippet";
  const currentStep = !hasProvider
    ? 1
    : !hasKey
      ? 2
      : !configCopied && !isReady
        ? 3
        : !isReady
          ? 4
          : 5;
  const secret = createdKey?.key || "YOUR_API_KEY";
  const snippet = `export OPENAI_BASE_URL=${baseUrl}/v1\nexport OPENAI_API_KEY=${secret}`;

  async function copy(value: string, id: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      globalThis.setTimeout(() => setCopied(""), 1800);
    } catch {
      setLoadError(t("configCopyFailed"));
    }
  }

  async function createKey(event: FormEvent) {
    event.preventDefault();
    if (!keyName.trim()) return;
    setCreatingKey(true);
    try {
      const response = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: keyName.trim() }),
      });
      const result = await readJson(response);
      if (!response.ok) {
        throw new Error(typeof result.error === "string" ? result.error : t("keyCreateFailed"));
      }
      setCreatedKey(result as CreatedKey);
      setData((current) => ({
        ...current,
        keys: [...current.keys, { ...(result as CreatedKey), isActive: true }],
      }));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("keyCreateFailed"));
    } finally {
      setCreatingKey(false);
    }
  }

  async function validateSetup() {
    setValidating(true);
    setValidation(null);
    try {
      const response = await fetch("/api/setup/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: selectedConnectionId }),
      });
      const result = await readJson(response);
      // A rejected request carries `{ error }` instead of `{ status, checks }`.
      setValidation(
        response.ok
          ? (result as unknown as Validation)
          : {
              status: "error",
              checks: [
                {
                  id: "server",
                  status: "fail",
                  message:
                    typeof result.error === "string" ? result.error : t("validateUnreachable"),
                },
              ],
            }
      );
    } catch {
      setValidation({
        status: "error",
        checks: [{ id: "server", status: "fail", message: t("validateUnreachable") }],
      });
    } finally {
      setValidating(false);
    }
  }

  const steps = [
    {
      done: hasProvider,
      title: t("connectTitle"),
      copy: hasProvider ? t("connectCount", { count: activeConnections.length }) : t("connectNone"),
    },
    {
      done: hasKey,
      title: t("keyTitle"),
      copy: hasKey ? t("keyExists") : t("keyNeeded"),
    },
    { done: configCopied || isReady, title: t("configTitle"), copy: t("configBody") },
    { done: isReady, title: t("validateTitle"), copy: t("validateBody") },
    {
      done: organized,
      title: t("organizeTitle"),
      copy: t.rich("organizeBody", {
        code: (chunks) => <code className="font-mono">{chunks}</code>,
      }),
    },
  ];

  const stepAction = [
    <div key="provider" className="flex flex-wrap items-center gap-3">
      {hasProvider ? (
        <Select
          value={selectedConnectionId}
          onChange={(event) => setSelectedConnectionId(event.target.value)}
          aria-label={t("connectionSelect")}
          options={activeConnections.map((connection) => ({
            value: connection.id,
            label:
              connection.displayName || connection.name || connection.provider || connection.id,
          }))}
        />
      ) : null}
      <StepLink href="/proxy/providers">
        {hasProvider ? t("manageProviders") : t("connectProvider")}
      </StepLink>
    </div>,
    !hasKey ? (
      <form key="key" className="flex flex-wrap items-end gap-2" onSubmit={createKey}>
        <Input
          value={keyName}
          onChange={(event) => setKeyName(event.target.value)}
          aria-label={t("keyNameLabel")}
        />
        <Button type="submit" size="sm" loading={creatingKey}>
          {t("keyCreate")}
        </Button>
      </form>
    ) : (
      <StepLink key="key" href="/proxy/endpoint#api-keys">
        {t("manageKeys")}
      </StepLink>
    ),
    <div key="config" className="flex min-w-0 flex-col gap-2">
      {createdKey ? <p className="text-sm text-text-muted">{t("configSecretOnce")}</p> : null}
      <pre className="min-w-0 overflow-x-auto rounded-lg border border-border bg-bg-subtle p-3 font-mono text-xs text-text-main">
        <code>{snippet}</code>
      </pre>
      <div>
        <Button
          variant="secondary"
          size="sm"
          icon={copied === "snippet" ? "check" : "content_copy"}
          onClick={() => copy(snippet, "snippet")}
        >
          {copied === "snippet" ? t("configCopied") : t("configCopy")}
        </Button>
      </div>
    </div>,
    <div key="validate" className="flex min-w-0 flex-col gap-3">
      <div>
        <Button
          onClick={validateSetup}
          disabled={!hasProvider || !hasKey || !selectedConnectionId}
          loading={validating}
        >
          {isReady ? t("validateAgain") : t("validateRun")}
        </Button>
      </div>
      {validation?.checks ? (
        <ul className="flex flex-col gap-1.5" aria-live="polite">
          {validation.checks.map((check) => (
            <li
              key={check.id}
              className={`flex items-start gap-2 text-sm ${
                check.status === "pass"
                  ? "text-feedback-success-foreground"
                  : "text-feedback-danger-foreground"
              }`}
            >
              <span className="material-symbols-outlined text-[length:var(--reddb-spatial-icon-size-md)] leading-none">
                {check.status === "pass" ? "check_circle" : "error"}
              </span>
              {check.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>,
    <div key="organize" className="min-w-0">
      {hasProvider ? (
        <RecommendedSetup onApplied={() => setOrganized(true)} />
      ) : (
        <p className="text-sm text-text-muted">{t("organizeConnectFirst")}</p>
      )}
    </div>,
  ];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6" aria-busy={loading}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t("kicker")}
          </p>
          <h1 className="text-2xl font-semibold text-text-main">{t("title")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-muted">{t("subtitle")}</p>
        </div>
        <div role="status">
          <Badge variant={isReady ? "success" : "default"} dot>
            {isReady ? t("ready") : loading ? t("checking") : t("stepOf", { step: currentStep })}
          </Badge>
        </div>
      </header>

      {loadError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-feedback-danger-border bg-feedback-danger-surface px-4 py-3 text-sm text-feedback-danger-foreground"
          role="alert"
        >
          {loadError}
          <Button variant="secondary" size="sm" onClick={load}>
            {t("retry")}
          </Button>
        </div>
      ) : null}

      <ol className="flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={step.title} aria-current={currentStep === index + 1 ? "step" : undefined}>
            <Card elev={currentStep === index + 1}>
              <div className="flex min-w-0 gap-4">
                <StepStatus done={step.done} active={currentStep === index + 1} />
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                  <div className="min-w-0">
                    <span className="font-mono text-xs text-text-muted">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <h2 className="text-base font-semibold text-text-main">{step.title}</h2>
                    <p className="text-sm text-text-muted">{step.copy}</p>
                  </div>
                  {stepAction[index]}
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ol>

      {isReady ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-feedback-success-border bg-feedback-success-surface px-4 py-3 text-feedback-success-foreground"
          role="status"
        >
          <Icon icon={CircleCheck} size="lg" color="current" className="leading-none" />
          <div className="min-w-0 flex-1">
            <strong>{t("successTitle")}</strong>
            <p className="text-sm">{t("successBody")}</p>
          </div>
          <StepLink href="/observe/logs">{t("openUsage")}</StepLink>
        </div>
      ) : null}
    </div>
  );
}
