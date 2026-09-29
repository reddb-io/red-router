"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Input, Modal, Select, TALL_MODAL_PROPS, Toggle } from "@/shared/components";
import {
  BUDGET_DURATIONS,
  type BudgetDuration,
  type BudgetOnExceed,
} from "@/shared/constants/budgets";
import { AssignmentPicker } from "./AssignmentPicker";
import { errorText, type AssignableRef, type BudgetRow } from "./budgetsTypes";

interface BudgetFormProps {
  budget: BudgetRow | null;
  keys: AssignableRef[];
  groups: AssignableRef[];
  optionsLoading: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function BudgetForm({ budget, keys, groups, optionsLoading, onClose, onSaved }: BudgetFormProps) {
  const t = useTranslations("budgets");
  const [name, setName] = useState(budget?.name ?? "");
  const [maxUsd, setMaxUsd] = useState(budget ? String(budget.maxUsd) : "");
  const [softUsd, setSoftUsd] = useState(budget?.softUsd != null ? String(budget.softUsd) : "");
  const [duration, setDuration] = useState<BudgetDuration>(budget?.duration ?? "monthly");
  const [resetTime, setResetTime] = useState(budget?.resetTime ?? "");
  const [onExceed, setOnExceed] = useState<BudgetOnExceed>(budget?.onExceed ?? "block");
  const [delaySeconds, setDelaySeconds] = useState(
    String((budget?.throttleDelayMs ?? 1000) / 1000)
  );
  const [keyIds, setKeyIds] = useState<string[]>(budget?.keyIds ?? []);
  const [groupIds, setGroupIds] = useState<string[]>(budget?.groupIds ?? []);
  const [enabled, setEnabled] = useState(budget?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const max = Number(maxUsd);
  const soft = softUsd.trim() === "" ? null : Number(softUsd);
  const delay = Number(delaySeconds);
  const problem = !name.trim()
    ? t("errName")
    : !Number.isFinite(max) || max <= 0
      ? t("errMax")
      : soft !== null && (!Number.isFinite(soft) || soft <= 0 || soft > max)
        ? t("errSoft")
        : onExceed === "throttle" && (!Number.isFinite(delay) || delay < 0 || delay > 300)
          ? t("errDelay")
          : "";

  const save = async () => {
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const fields = {
        name: name.trim(),
        maxUsd: max,
        softUsd: soft,
        duration,
        resetTime: duration === "total" || !resetTime ? null : resetTime,
        onExceed,
        throttleDelayMs: Math.round(delay * 1000),
        enabled,
      };
      const res = await fetch(budget ? `/api/budgets/${budget.id}` : "/api/budgets", {
        method: budget ? "PATCH" : "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(budget ? fields : { ...fields, keyIds, groupIds }),
      });
      if (!res.ok) {
        setError(
          errorText(await res.json().catch(() => ({})), t("saveFailed", { status: res.status }))
        );
        return;
      }
      if (budget) {
        const assigned = await fetch(`/api/budgets/${budget.id}/assignments`, {
          method: "PUT",
          headers: JSON_HEADERS,
          body: JSON.stringify({ keyIds, groupIds }),
        });
        if (!assigned.ok) {
          setError(
            errorText(
              await assigned.json().catch(() => ({})),
              t("saveFailed", { status: assigned.status })
            )
          );
          return;
        }
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Input
        label={t("fieldName")}
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={t("namePlaceholder")}
        maxLength={80}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label={t("fieldMax")}
          type="number"
          min="0"
          step="0.01"
          value={maxUsd}
          onChange={(event) => setMaxUsd(event.target.value)}
        />
        <Input
          label={t("fieldSoft")}
          type="number"
          min="0"
          step="0.01"
          value={softUsd}
          onChange={(event) => setSoftUsd(event.target.value)}
          hint={t("fieldSoftHint")}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label={t("fieldDuration")}
          value={duration}
          onChange={(event) => setDuration(event.target.value as BudgetDuration)}
          options={BUDGET_DURATIONS.map((value) => ({ value, label: t(`duration_${value}`) }))}
        />
        <Input
          label={t("fieldResetTime")}
          type="time"
          value={resetTime}
          onChange={(event) => setResetTime(event.target.value)}
          disabled={duration === "total"}
          hint={duration === "total" ? t("fieldResetTimeTotal") : t("fieldResetTimeHint")}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label={t("fieldOnExceed")}
          value={onExceed}
          onChange={(event) =>
            setOnExceed(event.target.value === "throttle" ? "throttle" : "block")
          }
          options={[
            { value: "block", label: t("onExceed_block") },
            { value: "throttle", label: t("onExceed_throttle") },
          ]}
        />
        {onExceed === "throttle" ? (
          <Input
            label={t("fieldDelay")}
            type="number"
            min="0"
            max="300"
            step="0.5"
            value={delaySeconds}
            onChange={(event) => setDelaySeconds(event.target.value)}
            hint={t("fieldDelayHint")}
          />
        ) : null}
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <span className="text-sm font-medium text-text-main">{t("assignTitle")}</span>
        <p className="text-xs text-text-muted">{t("assignHint")}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <AssignmentPicker
            label={t("assignKeys")}
            options={keys}
            selected={keyIds}
            onChange={setKeyIds}
            searchPlaceholder={t("searchKeys")}
            emptyText={t("noKeys")}
            loading={optionsLoading}
          />
          <AssignmentPicker
            label={t("assignGroups")}
            options={groups}
            selected={groupIds}
            onChange={setGroupIds}
            searchPlaceholder={t("searchGroups")}
            emptyText={t("noGroups")}
            loading={optionsLoading}
          />
        </div>
      </div>

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

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          {t("cancel")}
        </Button>
        <Button onClick={() => void save()} loading={saving} disabled={!name.trim()}>
          {budget ? t("save") : t("create")}
        </Button>
      </div>
    </div>
  );
}

interface BudgetFormModalProps extends BudgetFormProps {
  open: boolean;
}

export function BudgetFormModal({ open, ...formProps }: BudgetFormModalProps) {
  const t = useTranslations("budgets");
  return (
    <Modal
      isOpen={open}
      onClose={formProps.onClose}
      size="lg"
      title={formProps.budget ? t("editBudget") : t("newBudget")}
      {...TALL_MODAL_PROPS}
    >
      {open ? <BudgetForm key={formProps.budget?.id ?? "new"} {...formProps} /> : null}
    </Modal>
  );
}
