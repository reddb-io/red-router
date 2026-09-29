"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Card, ConfirmModal, Loading } from "@/shared/components";
import { SinkCard } from "./components/SinkCard";
import { SinkFormModal } from "./components/SinkFormModal";
import { errorText, type TestResult, type TransportDescriptor, type UsageSink } from "./types";

export function UsageSinksPageClient() {
  const t = useTranslations("usageSinks");
  const [sinks, setSinks] = useState<UsageSink[]>([]);
  const [types, setTypes] = useState<TransportDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<UsageSink | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UsageSink | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [sinksRes, typesRes] = await Promise.all([
        fetch("/api/usage-sinks"),
        fetch("/api/usage-sinks/types"),
      ]);
      const sinksData = await sinksRes.json().catch(() => ({}));
      const typesData = await typesRes.json().catch(() => ({}));
      if (!sinksRes.ok) throw new Error(errorText(sinksData, t("loadFailed")));
      setSinks(Array.isArray(sinksData.sinks) ? sinksData.sinks : []);
      setTypes(Array.isArray(typesData.types) ? typesData.types : []);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const toggle = async (sink: UsageSink, enabled: boolean) => {
    setNotice(null);
    const res = await fetch(`/api/usage-sinks/${sink.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok)
      setNotice(
        errorText(await res.json().catch(() => ({})), t("saveFailed", { status: res.status }))
      );
    await load();
  };

  const runTest = async (sink: UsageSink) => {
    setTestingId(sink.id);
    try {
      const res = await fetch(`/api/usage-sinks/${sink.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json().catch(() => ({}));
      const result: TestResult = res.ok
        ? data
        : { valid: false, error: errorText(data, t("saveFailed", { status: res.status })) };
      setTestResults((current) => ({ ...current, [sink.id]: result }));
    } finally {
      setTestingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await fetch(`/api/usage-sinks/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      await load();
    } finally {
      setDeleting(false);
    }
  };

  const openForm = (sink: UsageSink | null) => {
    setEditing(sink);
    setFormOpen(true);
  };

  if (loading) return <Loading />;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h1 className="text-lg font-semibold text-text-main">{t("title")}</h1>
          <p className="text-xs text-text-muted">{t("intro")}</p>
        </div>
        <Button icon="add" onClick={() => openForm(null)} className="shrink-0">
          {t("addSink")}
        </Button>
      </div>

      {loadError || notice ? (
        <p
          className="rounded-md border border-feedback-danger-border bg-feedback-danger-surface px-3 py-2 text-xs text-feedback-danger-foreground"
          role="alert"
        >
          {loadError ?? notice}
        </p>
      ) : null}

      {sinks.length === 0 && !loadError ? (
        <Card>
          <div className="py-10 text-center">
            <p className="mb-1 font-medium text-text-main">{t("emptyTitle")}</p>
            <p className="text-sm text-text-muted">{t("emptyBody")}</p>
          </div>
        </Card>
      ) : null}

      {sinks.map((sink) => (
        <SinkCard
          key={sink.id}
          sink={sink}
          testResult={testResults[sink.id] ?? null}
          testing={testingId === sink.id}
          onToggle={(enabled) => void toggle(sink, enabled)}
          onTest={() => void runTest(sink)}
          onEdit={() => openForm(sink)}
          onDelete={() => setDeleteTarget(sink)}
          onChange={() => void load()}
        />
      ))}

      <SinkFormModal
        open={formOpen}
        types={types}
        sink={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          setFormOpen(false);
          void load();
        }}
      />

      <ConfirmModal
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        variant="danger"
        title={t("deleteTitle")}
        confirmText={t("delete")}
        message={t("deleteMessage", { name: deleteTarget?.name ?? "" })}
      />
    </div>
  );
}
