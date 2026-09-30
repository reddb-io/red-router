"use client";

// Guardrails: which built-in guardrails run and in what order, the operator's own blocked
// keywords and patterns (content filter), and what they did in the last 24 hours. Everything
// here is off or unchanged until the operator saves.

import { Plus, ShieldCheck, X } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { useEffect, useState } from "react";
import { Badge, Button, Card, Input, Select, Toggle } from "@/shared/components";
import { GUARDRAIL_CATALOG } from "@/lib/guardrails/catalog";
import {
  hasGuardrailAssignments,
  normalizeGuardrailAssignments,
  resolveGuardrails,
} from "@/lib/guardrails/assignment";
import {
  CONTENT_FILTER_MAX_PATTERN_LENGTH,
  CONTENT_FILTER_MAX_RULES,
  normalizeContentFilterConfig,
  type ContentFilterRule,
} from "@/lib/guardrails/contentFilterRules";

interface RegistryRow {
  id: string;
  enabled: boolean;
  priority: number;
}

interface EventCounts {
  guardrailId: string;
  block: number;
  flag: number;
  mask: number;
  total: number;
}

type Status = { ok: boolean; message: string } | null;

const TYPE_OPTIONS = [
  { value: "keyword", label: "Keyword" },
  { value: "regex", label: "Regex" },
];
const SCOPE_OPTIONS = [
  { value: "request", label: "Requests" },
  { value: "response", label: "Responses" },
  { value: "both", label: "Both" },
];
const ACTION_OPTIONS = [
  { value: "block", label: "Block" },
  { value: "flag", label: "Flag only" },
];
const STAGE_LABEL: Record<string, string> = {
  request: "Requests",
  response: "Responses",
  both: "Both",
};

const labelOf = (id: string) => GUARDRAIL_CATALOG.find((entry) => entry.id === id)?.label ?? id;

function nextRuleId(rules: ContentFilterRule[]): string {
  const taken = new Set(rules.map((rule) => rule.id));
  let n = rules.length + 1;
  while (taken.has(`rule-${n}`)) n += 1;
  return `rule-${n}`;
}

export default function GuardrailsCard() {
  const [loaded, setLoaded] = useState(false);
  const [rows, setRows] = useState<RegistryRow[]>([]);
  const [assignments, setAssignments] = useState(normalizeGuardrailAssignments(undefined));
  const [filterEnabled, setFilterEnabled] = useState(false);
  const [rules, setRules] = useState<ContentFilterRule[]>([]);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [counts, setCounts] = useState<EventCounts[]>([]);
  const [busy, setBusy] = useState(false);
  const [registryStatus, setRegistryStatus] = useState<Status>(null);
  const [filterStatus, setFilterStatus] = useState<Status>(null);

  const loadEvents = async () => {
    try {
      const response = await fetch("/api/guardrails/events?limit=1");
      if (!response.ok) return;
      const data = await response.json();
      setCounts(Array.isArray(data.counts24h) ? data.counts24h : []);
    } catch {
      // The summary is informational; the editors still work without it.
    }
  };

  const load = async () => {
    try {
      const data = await (await fetch("/api/settings")).json();
      const stored = normalizeGuardrailAssignments(data.guardrailAssignments);
      const filter = normalizeContentFilterConfig(data.guardrailContentFilter);
      setAssignments(stored);
      setFilterEnabled(filter.enabled);
      setRules(filter.rules);
      // With no assignments yet the registry runs as it always has: every guardrail on at its
      // catalog priority. Show that, not the stricter "nothing explicit" resolution.
      setRows(
        hasGuardrailAssignments(stored)
          ? resolveGuardrails({ assignments: stored }).map(({ id, enabled, priority }) => ({
              id,
              enabled,
              priority,
            }))
          : GUARDRAIL_CATALOG.map((entry) => ({
              id: entry.id,
              enabled: entry.defaultEnabled,
              priority: entry.defaultPriority,
            }))
      );
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void load();
    // Load once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/guardrails/events?limit=1")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data) setCounts(Array.isArray(data.counts24h) ? data.counts24h : []);
      })
      .catch(() => {
        // The summary is informational; the editors still work without it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = async (body: Record<string, unknown>, success: string, report: (s: Status) => void) => {
    setBusy(true);
    report(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = Array.isArray(data?.error?.details)
          ? data.error.details
              .map((item: { message?: string }) => item?.message)
              .filter(Boolean)
              .join("; ")
          : "";
        report({
          ok: false,
          message: detail || data?.error?.message || "Could not save the settings.",
        });
      } else {
        report({ ok: true, message: success });
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const saveRegistry = () =>
    patch(
      {
        guardrailAssignments: {
          ...assignments,
          // The content filter row is driven by the filter's own switch below.
          global: rows.map(({ id, enabled, priority }) => ({
            id,
            enabled: id === "content-filter" ? true : enabled,
            priority,
          })),
        },
        guardrailContentFilter: { enabled: filterEnabled, rules },
      },
      "Saved. Changes apply within a few seconds.",
      setRegistryStatus
    );

  const saveFilter = () =>
    patch(
      { guardrailContentFilter: { enabled: filterEnabled, rules } },
      "Saved. Changes apply within a few seconds.",
      setFilterStatus
    );

  const updateRow = (id: string, change: Partial<RegistryRow>) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...change } : row)));

  const updateRule = (id: string, change: Partial<ContentFilterRule>) =>
    setRules((current) => current.map((rule) => (rule.id === id ? { ...rule, ...change } : rule)));

  const addRule = () =>
    setRules((current) =>
      current.length >= CONTENT_FILTER_MAX_RULES
        ? current
        : [
            ...current,
            {
              id: nextRuleId(current),
              label: "",
              type: "keyword",
              pattern: "",
              scope: "both",
              action: "block",
              enabled: true,
            },
          ]
    );

  const addKeywords = () => {
    const words = keywordDraft
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (words.length === 0) return;
    setRules((current) => {
      const next = [...current];
      for (const word of words) {
        if (next.length >= CONTENT_FILTER_MAX_RULES) break;
        next.push({
          id: nextRuleId(next),
          label: word.slice(0, 100),
          type: "keyword",
          pattern: word.slice(0, CONTENT_FILTER_MAX_PATTERN_LENGTH),
          scope: "both",
          action: "block",
          enabled: true,
        });
      }
      return next;
    });
    setKeywordDraft("");
  };

  const statusLine = (status: Status) =>
    status && (
      <p
        role="status"
        className={`text-sm ${status.ok ? "text-feedback-success-foreground" : "text-feedback-danger-foreground"}`}
      >
        {status.message}
      </p>
    );

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-primary/10 text-primary">
          <Icon icon={ShieldCheck} size="lg" color="current" />
        </div>
        <div>
          <p className="font-medium">Guardrails</p>
          <p className="text-sm text-text-muted">
            Choose which guardrails run and in what order, block your own words and patterns, and
            see what they did in the last 24 hours.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-3" aria-labelledby="guardrails-registry-heading">
          <p id="guardrails-registry-heading" className="text-sm font-medium">
            Built-in guardrails
          </p>
          <ul className="flex flex-col divide-y divide-elevation-sunken-border">
            {rows.map((row) => {
              const entry = GUARDRAIL_CATALOG.find((item) => item.id === row.id);
              return (
                <li key={row.id} className="flex flex-wrap items-center gap-3 py-2">
                  <div className="min-w-[12rem] flex-1">
                    <p className="text-sm font-medium">
                      {entry?.label ?? row.id}{" "}
                      <Badge size="sm">{STAGE_LABEL[entry?.stage ?? "both"]}</Badge>
                      {entry?.mutatesData && (
                        <>
                          {" "}
                          <Badge size="sm" variant="warning">
                            Changes content
                          </Badge>
                        </>
                      )}
                    </p>
                    <p className="text-xs text-text-muted">{entry?.description}</p>
                  </div>
                  <Input
                    label="Priority"
                    type="number"
                    min={0}
                    max={1000}
                    value={row.priority}
                    disabled={!loaded}
                    className="w-24"
                    onChange={(event) =>
                      updateRow(row.id, {
                        priority: Math.min(1000, Math.max(0, Math.trunc(Number(event.target.value) || 0))),
                      })
                    }
                  />
                  <Toggle
                    checked={row.id === "content-filter" ? filterEnabled : row.enabled}
                    disabled={!loaded}
                    ariaLabel={`${labelOf(row.id)} on or off`}
                    onChange={(checked) =>
                      row.id === "content-filter"
                        ? setFilterEnabled(checked)
                        : updateRow(row.id, { enabled: checked })
                    }
                  />
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-text-muted">
            Lower priority runs first. Guardrails that change content only act while their own
            opt-in setting is on; saving here lists them explicitly and never turns that setting on.
            Per-key and per-group overrides are stored in the same setting and kept when you save.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={saveRegistry} disabled={!loaded || busy}>
              Save guardrails
            </Button>
            {statusLine(registryStatus)}
          </div>
        </section>

        <section
          className="flex flex-col gap-3 border-t border-elevation-sunken-border pt-4"
          aria-labelledby="guardrails-filter-heading"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p id="guardrails-filter-heading" className="text-sm font-medium">
                Content filter
              </p>
              <p className="text-xs text-text-muted">
                Block or flag requests and responses that match your keywords or patterns. Blocked
                callers get a fixed message that never shows the rule. Streaming replies are only
                checked on the request side.
              </p>
            </div>
            <Toggle
              checked={filterEnabled}
              disabled={!loaded}
              ariaLabel="Content filter on or off"
              onChange={setFilterEnabled}
            />
          </div>

          {rules.length === 0 ? (
            <p className="text-sm text-text-muted">No rules yet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {rules.map((rule) => (
                <li
                  key={rule.id}
                  className="flex flex-col gap-2 rounded border border-elevation-sunken-border p-3"
                >
                  <div className="flex flex-wrap items-end gap-2">
                    <Input
                      label="Label"
                      value={rule.label}
                      maxLength={100}
                      className="min-w-[10rem] flex-1"
                      onChange={(event) => updateRule(rule.id, { label: event.target.value })}
                    />
                    <Select
                      label="Type"
                      value={rule.type}
                      options={TYPE_OPTIONS}
                      onChange={(event) =>
                        updateRule(rule.id, { type: event.target.value as ContentFilterRule["type"] })
                      }
                    />
                    <Select
                      label="Applies to"
                      value={rule.scope}
                      options={SCOPE_OPTIONS}
                      onChange={(event) =>
                        updateRule(rule.id, { scope: event.target.value as ContentFilterRule["scope"] })
                      }
                    />
                    <Select
                      label="Action"
                      value={rule.action}
                      options={ACTION_OPTIONS}
                      onChange={(event) =>
                        updateRule(rule.id, {
                          action: event.target.value as ContentFilterRule["action"],
                        })
                      }
                    />
                    <Toggle
                      checked={rule.enabled}
                      ariaLabel={`Rule ${rule.label || rule.id} on or off`}
                      onChange={(checked) => updateRule(rule.id, { enabled: checked })}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove rule ${rule.label || rule.id}`}
                      onClick={() => setRules((current) => current.filter((item) => item.id !== rule.id))}
                    >
                      <Icon icon={X} size="sm" color="current" />
                    </Button>
                  </div>
                  <Input
                    label={rule.type === "regex" ? "Pattern" : "Word or phrase"}
                    value={rule.pattern}
                    maxLength={CONTENT_FILTER_MAX_PATTERN_LENGTH}
                    hint={
                      rule.type === "regex"
                        ? "Simple patterns only: no lookaround, backreferences or nested repeats."
                        : undefined
                    }
                    onChange={(event) => updateRule(rule.id, { pattern: event.target.value })}
                  />
                  {rule.type === "keyword" && (
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={rule.wholeWord === true}
                        onChange={(event) => updateRule(rule.id, { wholeWord: event.target.checked })}
                      />
                      Whole word only
                    </label>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor="guardrails-keyword-draft" className="text-sm font-medium text-text-main">
              Add keywords
            </label>
            <textarea
              id="guardrails-keyword-draft"
              rows={3}
              value={keywordDraft}
              onChange={(event) => setKeywordDraft(event.target.value)}
              placeholder={"one word or phrase per line"}
              className="rounded border border-control-edge bg-surface px-3 py-2 text-sm text-text-main"
            />
            <p className="text-xs text-text-muted">
              Each line becomes a blocking keyword rule for requests and responses. Matching ignores
              case. Up to {CONTENT_FILTER_MAX_RULES} rules in total.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="secondary" onClick={addKeywords} disabled={!loaded || !keywordDraft.trim()}>
              Add keywords
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={addRule}
              disabled={!loaded || rules.length >= CONTENT_FILTER_MAX_RULES}
            >
              <Icon icon={Plus} size="sm" color="current" /> Add rule
            </Button>
            <Button size="sm" onClick={saveFilter} disabled={!loaded || busy}>
              Save content filter
            </Button>
            {statusLine(filterStatus)}
          </div>
        </section>

        <section
          className="flex flex-col gap-3 border-t border-elevation-sunken-border pt-4"
          aria-labelledby="guardrails-events-heading"
        >
          <div className="flex items-center justify-between gap-3">
            <p id="guardrails-events-heading" className="text-sm font-medium">
              Last 24 hours
            </p>
            <Button size="sm" variant="ghost" onClick={() => void loadEvents()}>
              Refresh
            </Button>
          </div>
          {counts.length === 0 ? (
            <p className="text-sm text-text-muted">No guardrail activity in the last 24 hours.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-text-muted">
                    <th className="py-1 pr-4 font-medium">Guardrail</th>
                    <th className="py-1 pr-4 font-medium">Blocked</th>
                    <th className="py-1 pr-4 font-medium">Flagged</th>
                    <th className="py-1 pr-4 font-medium">Masked</th>
                  </tr>
                </thead>
                <tbody>
                  {counts.map((row) => (
                    <tr key={row.guardrailId} className="border-t border-elevation-sunken-border">
                      <td className="py-1 pr-4">{labelOf(row.guardrailId)}</td>
                      <td className="py-1 pr-4">{row.block}</td>
                      <td className="py-1 pr-4">{row.flag}</td>
                      <td className="py-1 pr-4">{row.mask}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </Card>
  );
}
