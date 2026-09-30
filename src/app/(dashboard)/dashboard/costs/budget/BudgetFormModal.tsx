"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Input, Modal, Select, TALL_MODAL_PROPS, Toggle } from "@/shared/components";
import {
  BUDGET_DURATIONS,
  BUDGET_MODEL_KEY_MAX,
  BUDGET_MODEL_KEY_REGEX,
  BUDGET_RATE_LIMIT_MAX,
  type BudgetDuration,
  type BudgetOnExceed,
} from "@/shared/constants/budgets";
import {
  END_USER_MAX_LENGTH,
  normalizeEndUser,
  normalizeTag,
} from "@/shared/constants/attribution";
import { AssignmentPicker } from "./AssignmentPicker";
import { ScopeChipsInput } from "./ScopeChipsInput";
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

interface ModelCapDraft {
  key: string;
  usd: string;
}

/** A rate limit field: empty = no limit, otherwise a whole number of at least 1. */
function parseRate(text: string): number | null | "invalid" {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isInteger(value) && value > 0 && value <= BUDGET_RATE_LIMIT_MAX ? value : "invalid";
}

/** The model caps as the API wants them, or the reason the drafts cannot be sent. */
function parseModelCaps(
  drafts: readonly ModelCapDraft[]
): { caps: Record<string, number> } | { problem: "key" | "usd" | "duplicate" } {
  const caps: Record<string, number> = {};
  for (const draft of drafts) {
    const key = draft.key.trim();
    if (key === "" && draft.usd.trim() === "") continue;
    if (key.length > BUDGET_MODEL_KEY_MAX || !BUDGET_MODEL_KEY_REGEX.test(key)) {
      return { problem: "key" };
    }
    const usd = Number(draft.usd);
    if (!Number.isFinite(usd) || usd <= 0) return { problem: "usd" };
    if (Object.keys(caps).some((existing) => existing.toLowerCase() === key.toLowerCase())) {
      return { problem: "duplicate" };
    }
    caps[key] = usd;
  }
  return { caps };
}

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
  const [tags, setTags] = useState<string[]>(budget?.tags ?? []);
  const [users, setUsers] = useState<string[]>(budget?.users ?? []);
  const [tpm, setTpm] = useState(budget?.tpmLimit != null ? String(budget.tpmLimit) : "");
  const [rpm, setRpm] = useState(budget?.rpmLimit != null ? String(budget.rpmLimit) : "");
  const [modelCaps, setModelCaps] = useState<ModelCapDraft[]>(
    Object.entries(budget?.modelMax ?? {}).map(([key, usd]) => ({ key, usd: String(usd) }))
  );
  const [enabled, setEnabled] = useState(budget?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const max = Number(maxUsd);
  const soft = softUsd.trim() === "" ? null : Number(softUsd);
  const delay = Number(delaySeconds);
  const tpmLimit = parseRate(tpm);
  const rpmLimit = parseRate(rpm);
  const parsedCaps = parseModelCaps(modelCaps);
  const problem = !name.trim()
    ? t("errName")
    : !Number.isFinite(max) || max <= 0
      ? t("errMax")
      : soft !== null && (!Number.isFinite(soft) || soft <= 0 || soft > max)
        ? t("errSoft")
        : onExceed === "throttle" && (!Number.isFinite(delay) || delay < 0 || delay > 300)
          ? t("errDelay")
          : tpmLimit === "invalid" || rpmLimit === "invalid"
            ? t("errRate")
            : "problem" in parsedCaps
              ? t(`errModel_${parsedCaps.problem}`)
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
        tpmLimit: tpmLimit === "invalid" ? null : tpmLimit,
        rpmLimit: rpmLimit === "invalid" ? null : rpmLimit,
        modelMax: "caps" in parsedCaps ? parsedCaps.caps : {},
        enabled,
      };
      const res = await fetch(budget ? `/api/budgets/${budget.id}` : "/api/budgets", {
        method: budget ? "PATCH" : "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(budget ? fields : { ...fields, keyIds, groupIds, tags, users }),
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
          body: JSON.stringify({ keyIds, groupIds, tags, users }),
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
        <span className="text-sm font-medium text-text-main">{t("rateLimitsTitle")}</span>
        <p className="text-xs text-text-muted">{t("rateLimitsHint")}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label={t("fieldTpm")}
            type="number"
            min="1"
            step="1"
            value={tpm}
            onChange={(event) => setTpm(event.target.value)}
            hint={t("fieldRateHint")}
          />
          <Input
            label={t("fieldRpm")}
            type="number"
            min="1"
            step="1"
            value={rpm}
            onChange={(event) => setRpm(event.target.value)}
            hint={t("fieldRateHint")}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <span className="text-sm font-medium text-text-main">{t("modelCapsTitle")}</span>
        <p className="text-xs text-text-muted">{t("modelCapsHint")}</p>
        {modelCaps.map((cap, index) => (
          <div key={index} className="grid grid-cols-[1fr_8rem_auto] items-end gap-2">
            <Input
              label={index === 0 ? t("modelCapKey") : undefined}
              aria-label={t("modelCapKey")}
              value={cap.key}
              placeholder={t("modelCapKeyPlaceholder")}
              maxLength={BUDGET_MODEL_KEY_MAX}
              onChange={(event) =>
                setModelCaps(
                  modelCaps.map((entry, at) =>
                    at === index ? { ...entry, key: event.target.value } : entry
                  )
                )
              }
            />
            <Input
              label={index === 0 ? t("modelCapUsd") : undefined}
              aria-label={t("modelCapUsd")}
              type="number"
              min="0"
              step="0.01"
              value={cap.usd}
              onChange={(event) =>
                setModelCaps(
                  modelCaps.map((entry, at) =>
                    at === index ? { ...entry, usd: event.target.value } : entry
                  )
                )
              }
            />
            <Button
              variant="ghost"
              icon="close"
              aria-label={t("removeModelCap", { key: cap.key || String(index + 1) })}
              onClick={() => setModelCaps(modelCaps.filter((_, at) => at !== index))}
            />
          </div>
        ))}
        <div>
          <Button
            variant="secondary"
            size="sm"
            icon="add"
            onClick={() => setModelCaps([...modelCaps, { key: "", usd: "" }])}
          >
            {t("addModelCap")}
          </Button>
        </div>
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
        <ScopeChipsInput
          label={t("assignTags")}
          hint={t("assignTagsHint")}
          placeholder={t("tagPlaceholder")}
          values={tags}
          onChange={setTags}
          normalize={normalizeTag}
          splitOn=","
        />
        <ScopeChipsInput
          label={t("assignUsers")}
          hint={t("assignUsersHint", { max: END_USER_MAX_LENGTH })}
          placeholder={t("userPlaceholder")}
          values={users}
          onChange={setUsers}
          normalize={normalizeEndUser}
        />
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
