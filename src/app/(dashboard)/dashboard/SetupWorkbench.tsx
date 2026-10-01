"use client";

import { CircleCheck } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Badge, Button, Card, Input, RecommendedSetup, Select } from "@/shared/components";
import ConnectionModelSelect from "@/shared/components/ConnectionModelSelect";
import { readSetupProgress, writeSetupProgress, selectionFingerprint } from "@/lib/setup/progress";
import { useDisplayBaseUrl } from "@/shared/hooks";

interface SetupConnection {
  id: string;
  provider?: string;
  name?: string;
  displayName?: string;
  isActive?: boolean;
  tenantId?: string;
}

interface SetupKey {
  id?: string;
  name?: string;
  tenantId?: string;
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
  selection?: string;
  credential?: string;
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
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [existingSecret, setExistingSecret] = useState("");
  const [copiedSelection, setCopiedSelection] = useState("");
  const [progressLoaded, setProgressLoaded] = useState(false);
  const [smoke, setSmoke] = useState<{
    status: "running" | "pass" | "fail";
    selection: string;
    credential: string;
  } | null>(null);
  const pending = useRef<AbortController | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [keyName, setKeyName] = useState(() => t("keyDefaultName"));
  const [creatingKey, setCreatingKey] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreatedKey | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [validationRequest, setValidationRequest] = useState<{
    selection: string;
    credential: string;
  } | null>(null);
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
      setSelectedKeyId(
        (current) =>
          current ||
          (keys.keys as SetupKey[] | undefined)?.find(
            (item) => item.isActive !== false && item.isBanned !== true
          )?.id ||
          ""
      );
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
    let cancelled = false;
    // Read browser storage after hydration, with identical initial server/client markup.
    queueMicrotask(() => {
      if (cancelled) return;
      let saved: ReturnType<typeof readSetupProgress> = null;
      try {
        saved = readSetupProgress(localStorage);
      } catch {
        /* Storage may be blocked. */
      }
      if (saved) {
        setSelectedConnectionId(saved.connectionId);
        setSelectedModel(saved.model);
        setSelectedKeyId(saved.apiKeyId);
        setCopiedSelection(saved.copiedSelection);
        setOrganized(saved.organized);
      }
      setProgressLoaded(true);
      void load();
    });
    return () => {
      cancelled = true;
      pending.current?.abort();
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, [load]);

  const activeConnections = useMemo(
    () => data.connections.filter((item) => item.isActive !== false),
    [data.connections]
  );
  const activeKeys = data.keys.filter((item) => item.isActive !== false && item.isBanned !== true);
  const hasProvider = activeConnections.some(
    (connection) => connection.id === selectedConnectionId
  );
  const hasKey = activeKeys.some((key) => key.id === selectedKeyId);
  const secret = createdKey?.id === selectedKeyId ? createdKey?.key || "" : existingSecret;
  const selection = {
    connectionId: selectedConnectionId,
    model: selectedModel,
    apiKeyId: selectedKeyId,
  };
  const fingerprint = selectionFingerprint(selection, baseUrl);
  const fingerprintRef = useRef(fingerprint);
  const currentValidation =
    validation?.selection === fingerprint && validation.credential === secret ? validation : null;
  const validating =
    validationRequest?.selection === fingerprint && validationRequest.credential === secret;
  const smokeStatus =
    smoke?.selection === fingerprint && smoke.credential === secret ? smoke.status : "idle";
  const isReady = hasProvider && hasKey && currentValidation?.status === "ready";
  const configCopied = !!copiedSelection && copiedSelection === fingerprint;
  const canCheck = hasProvider && hasKey && !!selectedModel && !!secret;
  const currentStep = !hasProvider
    ? 1
    : !hasKey
      ? 2
      : !configCopied && !isReady
        ? 3
        : !isReady
          ? 4
          : 5;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const snippet =
    secret && selectedModel && hasKey
      ? `export OPENAI_BASE_URL=${quote(`${baseUrl}/v1`)}\nexport OPENAI_API_KEY=${quote(secret)}`
      : "";

  useEffect(() => {
    fingerprintRef.current = fingerprint;
    pending.current?.abort();
  }, [fingerprint, secret]);

  useEffect(() => {
    if (!progressLoaded) return;
    try {
      writeSetupProgress(localStorage, {
        connectionId: selectedConnectionId,
        model: selectedModel,
        apiKeyId: selectedKeyId,
        copiedSelection,
        organized,
      });
    } catch {
      /* Storage may be blocked. */
    }
  }, [
    progressLoaded,
    selectedConnectionId,
    selectedModel,
    selectedKeyId,
    copiedSelection,
    organized,
  ]);

  async function copy(value: string, id: string) {
    if (!value) return;
    const copiedFingerprint = fingerprint;
    try {
      await navigator.clipboard.writeText(value);
      if (fingerprintRef.current !== copiedFingerprint) return;
      setCopied(id);
      setCopiedSelection(copiedFingerprint);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = globalThis.setTimeout(() => setCopied(""), 1800);
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
        body: JSON.stringify({
          name: keyName.trim(),
          tenantId: data.connections.find((connection) => connection.id === selectedConnectionId)
            ?.tenantId,
        }),
      });
      const result = await readJson(response);
      if (!response.ok) {
        throw new Error(typeof result.error === "string" ? result.error : t("keyCreateFailed"));
      }
      setCreatedKey(result as CreatedKey);
      setSelectedKeyId(String(result.id || ""));
      setExistingSecret("");
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
    if (!canCheck) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setValidationRequest({ selection: fingerprint, credential: secret });
    setValidation(null);
    try {
      const response = await fetch("/api/setup/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...selection, apiKey: secret }),
        signal: controller.signal,
      });
      const result = await readJson(response);
      if (controller.signal.aborted) return;
      // A rejected request carries `{ error }` instead of `{ status, checks }`.
      const resultValidation: Validation = response.ok
        ? (result as unknown as Validation)
        : {
            status: "error",
            checks: [
              {
                id: "server",
                status: "fail",
                message: typeof result.error === "string" ? result.error : t("validateUnreachable"),
              },
            ],
          };
      setValidation({ ...resultValidation, selection: fingerprint, credential: secret });
    } catch {
      if (controller.signal.aborted) return;
      setValidation({
        selection: fingerprint,
        credential: secret,
        status: "error",
        checks: [{ id: "server", status: "fail", message: t("validateUnreachable") }],
      });
    } finally {
      if (pending.current === controller) setValidationRequest(null);
    }
  }

  async function testInference() {
    if (!canCheck || smokeStatus === "running") return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setSmoke({ status: "running", selection: fingerprint, credential: secret });
    try {
      // This goes through the public route with the actual client credential,
      // so auth, tenant policy, quotas and usage accounting all apply.
      const response = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${secret}`,
          "x-omniroute-connection": selectedConnectionId,
          "x-omniroute-no-cache": "true",
        },
        body: JSON.stringify({
          model: selectedModel,
          stream: false,
          max_tokens: 64,
          messages: [{ role: "user", content: "Reply with OK." }],
        }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      });
      const result = await readJson(response);
      const choices = result.choices;
      const completed =
        response.ok &&
        Array.isArray(choices) &&
        choices.length > 0 &&
        response.headers.get("X-OmniRoute-Selected-Connection-Id") === selectedConnectionId &&
        !response.headers.has("X-OmniRoute-Emergency-Fallback");
      if (!controller.signal.aborted)
        setSmoke({
          status: completed ? "pass" : "fail",
          selection: fingerprint,
          credential: secret,
        });
    } catch {
      if (!controller.signal.aborted)
        setSmoke({ status: "fail", selection: fingerprint, credential: secret });
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
      <ConnectionModelSelect
        role="chat"
        connections={data.connections}
        value={{ connectionId: selectedConnectionId, model: selectedModel }}
        onChange={({ connectionId, model }) => {
          setSelectedConnectionId(connectionId);
          setSelectedModel(model);
          setValidation(null);
        }}
      />
      <StepLink href="/proxy/providers">
        {hasProvider ? t("manageProviders") : t("connectProvider")}
      </StepLink>
    </div>,
    <div key="key" className="flex flex-col gap-3">
      {activeKeys.length ? (
        <Select
          label={t("keySelect")}
          aria-label={t("keySelect")}
          value={selectedKeyId}
          options={[
            ...(!hasKey && selectedKeyId
              ? [{ value: selectedKeyId, label: `${selectedKeyId} (unavailable)` }]
              : []),
            ...activeKeys.map((key) => ({
              value: key.id || "",
              label: `${key.name || key.id} · ${key.tenantId || "red"} · ${key.id?.slice(0, 8)}`,
            })),
          ]}
          onChange={(event) => {
            setSelectedKeyId(event.target.value);
            setExistingSecret("");
            setValidation(null);
          }}
        />
      ) : null}
      {hasKey && createdKey?.id !== selectedKeyId ? (
        <Input
          label={t("keySecretLabel")}
          type="password"
          autoComplete="off"
          value={existingSecret}
          onChange={(event) => setExistingSecret(event.target.value)}
          hint={t("keySecretHint")}
        />
      ) : null}
      <form className="flex flex-wrap items-end gap-2" onSubmit={createKey}>
        <Input
          value={keyName}
          onChange={(event) => setKeyName(event.target.value)}
          aria-label={t("keyNameLabel")}
        />
        <Button type="submit" size="sm" loading={creatingKey}>
          {t("keyCreate")}
        </Button>
      </form>
      <StepLink href="/proxy/keys">{t("manageKeys")}</StepLink>
    </div>,
    <div key="config" className="flex min-w-0 flex-col gap-2">
      {createdKey?.id === selectedKeyId ? (
        <p className="text-sm text-text-muted">{t("configSecretOnce")}</p>
      ) : null}
      <pre className="min-w-0 overflow-x-auto rounded-lg border border-border bg-bg-subtle p-3 font-mono text-xs text-text-main">
        <code>{snippet || t("configNeedsSecret")}</code>
      </pre>
      <div>
        <Button
          variant="secondary"
          size="sm"
          icon={copied === "snippet" ? "check" : "content_copy"}
          onClick={() => copy(snippet, "snippet")}
          disabled={!canCheck}
        >
          {copied === "snippet" ? t("configCopied") : t("configCopy")}
        </Button>
      </div>
    </div>,
    <div key="validate" className="flex min-w-0 flex-col gap-3">
      <div>
        <Button
          onClick={validateSetup}
          disabled={!canCheck || smokeStatus === "running"}
          loading={validating}
        >
          {isReady ? t("validateAgain") : t("validateRun")}
        </Button>
      </div>
      <p className="text-sm text-text-muted">{t("testInferenceWarning")}</p>
      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={testInference}
          disabled={!canCheck || validating}
          loading={smokeStatus === "running"}
        >
          {t("testInference")}
        </Button>
      </div>
      {smokeStatus === "pass" || smokeStatus === "fail" ? (
        <p
          role="status"
          className={
            smokeStatus === "pass"
              ? "text-feedback-success-foreground"
              : "text-feedback-danger-foreground"
          }
        >
          {smokeStatus === "pass" ? t("testInferencePassed") : t("testInferenceFailed")}
        </p>
      ) : null}
      {currentValidation?.checks ? (
        <ul className="flex flex-col gap-1.5" aria-live="polite">
          {currentValidation.checks.map((check) => (
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
