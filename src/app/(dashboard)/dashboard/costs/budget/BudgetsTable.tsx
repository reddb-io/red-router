"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Card, ConfirmModal, Loading, Toggle } from "@/shared/components";
import { BudgetFormModal } from "./BudgetFormModal";
import { BudgetMeter } from "./BudgetMeter";
import { errorText, formatUsd, type AssignableRef, type BudgetRow } from "./budgetsTypes";

const JSON_HEADERS = { "Content-Type": "application/json" };
/** Names shown in the "assigned to" cell before the rest collapse into "+N". */
const NAMES_SHOWN = 2;
/** Tag / end-user chips shown in the "assigned to" cell before the rest collapse into "+N". */
const CHIPS_SHOWN = 3;

/**
 * Reusable budgets: one row per budget with its limit, window, behaviour on exceed, who it
 * applies to and how much of the current window is used. Table styling follows the usage-sinks
 * deliveries table (DS tokens: border-border, text-text-muted, feedback roles).
 */
export default function BudgetsTable() {
  const t = useTranslations("budgets");
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [keys, setKeys] = useState<AssignableRef[]>([]);
  const [groups, setGroups] = useState<AssignableRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<BudgetRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BudgetRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/budgets");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(data, t("loadFailed")));
      setBudgets(Array.isArray(data.budgets) ? data.budgets : []);
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

  // The two assignable lists come from the existing endpoints; a failure only empties the pickers.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [keysRes, groupsRes] = await Promise.all([
          fetch("/api/keys"),
          fetch("/api/keys/groups"),
        ]);
        const keysData = await keysRes.json().catch(() => ({}));
        const groupsData = await groupsRes.json().catch(() => ({}));
        if (cancelled) return;
        setKeys(
          Array.isArray(keysData.keys)
            ? keysData.keys.map((key: { id: string; name?: string }) => ({
                id: key.id,
                name: key.name || key.id,
              }))
            : []
        );
        setGroups(
          Array.isArray(groupsData.groups)
            ? groupsData.groups.map((group: { id: string; name?: string }) => ({
                id: group.id,
                name: group.name || group.id,
              }))
            : []
        );
      } finally {
        if (!cancelled) setOptionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const key of keys) map.set(`key:${key.id}`, key.name);
    for (const group of groups) map.set(`group:${group.id}`, group.name);
    return map;
  }, [keys, groups]);

  // Tags and end users are client-supplied text; React renders them escaped.
  const chipsOf = (budget: BudgetRow): { id: string; label: string }[] => [
    ...(budget.tags ?? []).map((value) => ({ id: `tag:${value}`, label: t("chipTag", { value }) })),
    ...(budget.users ?? []).map((value) => ({
      id: `user:${value}`,
      label: t("chipUser", { value }),
    })),
  ];

  const assignedTo = (budget: BudgetRow): string => {
    const labels = [
      ...budget.groupIds.map((id) => names.get(`group:${id}`) ?? t("deletedGroup")),
      ...budget.keyIds.map((id) => names.get(`key:${id}`) ?? t("deletedKey")),
    ];
    if (labels.length === 0) return chipsOf(budget).length > 0 ? "" : t("assignedNobody");
    const shown = labels.slice(0, NAMES_SHOWN).join(", ");
    return labels.length > NAMES_SHOWN ? `${shown} +${labels.length - NAMES_SHOWN}` : shown;
  };

  const toggle = async (budget: BudgetRow, enabled: boolean) => {
    setNotice(null);
    const res = await fetch(`/api/budgets/${budget.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      setNotice(
        errorText(await res.json().catch(() => ({})), t("saveFailed", { status: res.status }))
      );
    }
    await load();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/budgets/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        setNotice(
          errorText(await res.json().catch(() => ({})), t("deleteFailed", { status: res.status }))
        );
      }
      setDeleteTarget(null);
      await load();
    } finally {
      setDeleting(false);
    }
  };

  const openForm = (budget: BudgetRow | null) => {
    setEditing(budget);
    setFormOpen(true);
  };

  if (loading) return <Loading />;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold text-text-main">{t("title")}</h2>
          <p className="text-xs text-text-muted">{t("intro")}</p>
        </div>
        <Button icon="add" onClick={() => openForm(null)} className="shrink-0">
          {t("newBudget")}
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

      {budgets.length === 0 && !loadError ? (
        <Card>
          <div className="py-10 text-center">
            <p className="mb-1 font-medium text-text-main">{t("emptyTitle")}</p>
            <p className="text-sm text-text-muted">{t("emptyBody")}</p>
          </div>
        </Card>
      ) : null}

      {budgets.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-left text-xs">
            <thead className="text-text-muted">
              <tr className="border-b border-border">
                <th className="px-3 py-2 font-medium">{t("colName")}</th>
                <th className="px-3 py-2 font-medium">{t("colLimit")}</th>
                <th className="px-3 py-2 font-medium">{t("colRate")}</th>
                <th className="px-3 py-2 font-medium">{t("colWindow")}</th>
                <th className="px-3 py-2 font-medium">{t("colOnExceed")}</th>
                <th className="px-3 py-2 font-medium">{t("colAssigned")}</th>
                <th className="px-3 py-2 font-medium">{t("colUsed")}</th>
                <th className="px-3 py-2 font-medium">{t("colEnabled")}</th>
                <th className="px-3 py-2">
                  <span className="sr-only">{t("colActions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {budgets.map((budget) => (
                <tr key={budget.id} className="border-b border-border align-middle last:border-0">
                  <td className="max-w-48 truncate px-3 py-2 font-medium text-text-main">
                    {budget.name}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-text-main">
                    {formatUsd(budget.maxUsd)}
                    <div className="text-text-muted">
                      {t("softAt", { amount: formatUsd(budget.effectiveSoftUsd) })}
                    </div>
                    {Object.keys(budget.modelMax ?? {}).length > 0 ? (
                      <div className="text-text-muted">
                        {t("modelCapsCount", { count: Object.keys(budget.modelMax).length })}
                      </div>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-text-main">
                    {budget.tpmLimit == null && budget.rpmLimit == null ? (
                      <span className="text-text-muted">{t("rateNone")}</span>
                    ) : (
                      <>
                        {budget.tpmLimit != null ? (
                          <div>{t("rateTokens", { count: budget.tpmLimit.toLocaleString() })}</div>
                        ) : null}
                        {budget.rpmLimit != null ? (
                          <div>
                            {t("rateRequests", { count: budget.rpmLimit.toLocaleString() })}
                          </div>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-text-main">
                    {t(`duration_${budget.duration}`)}
                    {budget.duration !== "total" && budget.resetTime ? (
                      <div className="text-text-muted">
                        {t("resetsAt", { time: budget.resetTime })}
                      </div>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <Badge size="sm" variant={budget.onExceed === "block" ? "default" : "outline"}>
                      {budget.onExceed === "block"
                        ? t("onExceed_block")
                        : t("throttleBy", { seconds: budget.throttleDelayMs / 1000 })}
                    </Badge>
                  </td>
                  <td className="max-w-64 px-3 py-2 text-text-main">
                    {assignedTo(budget) ? (
                      <div className="truncate" title={assignedTo(budget)}>
                        {assignedTo(budget)}
                      </div>
                    ) : null}
                    {chipsOf(budget).length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {chipsOf(budget)
                          .slice(0, CHIPS_SHOWN)
                          .map((chip) => (
                            <Badge key={chip.id} size="sm" variant="outline">
                              <span className="max-w-32 truncate" title={chip.label}>
                                {chip.label}
                              </span>
                            </Badge>
                          ))}
                        {chipsOf(budget).length > CHIPS_SHOWN ? (
                          <span className="text-text-muted">
                            {`+${chipsOf(budget).length - CHIPS_SHOWN}`}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                  <td className="min-w-40 px-3 py-2">
                    <div className="mb-1 whitespace-nowrap tabular-nums text-text-main">
                      {t("usedOf", {
                        spent: formatUsd(budget.usage.spentUsd),
                        max: formatUsd(budget.maxUsd),
                      })}
                    </div>
                    <BudgetMeter
                      spentUsd={budget.usage.spentUsd}
                      maxUsd={budget.maxUsd}
                      label={t("usedMeter", { name: budget.name })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Toggle
                      size="sm"
                      checked={budget.enabled}
                      onChange={(enabled) => void toggle(budget, enabled)}
                      ariaLabel={t("toggleBudget", { name: budget.name })}
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="edit"
                      aria-label={t("editBudgetNamed", { name: budget.name })}
                      title={t("edit")}
                      onClick={() => openForm(budget)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="delete"
                      aria-label={t("deleteBudgetNamed", { name: budget.name })}
                      title={t("delete")}
                      onClick={() => setDeleteTarget(budget)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <BudgetFormModal
        open={formOpen}
        budget={editing}
        keys={keys}
        groups={groups}
        optionsLoading={optionsLoading}
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
