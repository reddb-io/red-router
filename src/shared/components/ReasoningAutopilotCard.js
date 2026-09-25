"use client";

import { useEffect, useState } from "react";
import { Card, Select, SegmentedControl, Toggle } from "@/shared/components";
import { translate } from "@/i18n/runtime";
import ApiKeyPicker from "./ApiKeyPicker";
import Icon from "./Icon";
import { reasoningAutopilotSummary } from "@/shared/utils/autopilotSummary";

// Same three states as the decision router: a test run (stored "shadow") logs the
// level it would pick (Usage → request details, X-RedRouter-Reasoning header)
// without touching the request, which is how the effect is measured before it is
// turned on ("enforce").
const MODES = [
  { value: "off", label: "Off" },
  { value: "shadow", label: "Test run" },
  { value: "enforce", label: "On" },
];
const SCOPES = [
  { value: "all", label: "Every request" },
  { value: "chosen", label: "Chosen keys and combos" },
];
const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export default function ReasoningAutopilotCard() {
  const [config, setConfig] = useState(null);
  const [keyChips, setKeyChips] = useState([]);
  const [combos, setCombos] = useState([]);

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then(async (data) => {
        const next = data?.reasoningAutopilot;
        if (!next) return;
        setConfig(next);
        // Names for the chosen keys only: the key list itself may be huge.
        const ids = next.apiKeys || [];
        if (!ids.length) return;
        const found = await fetch(`/api/keys/search?ids=${ids.map(encodeURIComponent).join(",")}`).then((r) => r.json()).catch(() => ({}));
        const byId = new Map((found.keys || []).map((k) => [k.id, k.name]));
        setKeyChips(ids.map((id) => ({ id, name: byId.get(id) || null })));
      })
      .catch(() => {});
    fetch("/api/combos", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setCombos(data?.combos || []))
      .catch(() => {});
  }, []);

  if (!config) return null;

  const comboNames = config.combos || [];

  // Optimistic autosave, like the decision router card.
  const patch = (next) => {
    setConfig(next);
    fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reasoningAutopilot: next }),
    }).catch(() => {});
  };
  const set = (key, value) => patch({ ...config, [key]: value });

  const setFloor = (floor) => {
    const ceiling = LEVELS.indexOf(floor) > LEVELS.indexOf(config.ceiling) ? floor : config.ceiling;
    patch({ ...config, floor, ceiling });
  };
  const setCeiling = (ceiling) => {
    const floor = LEVELS.indexOf(config.floor) > LEVELS.indexOf(ceiling) ? ceiling : config.floor;
    patch({ ...config, floor, ceiling });
  };
  const setKeys = (chips) => {
    setKeyChips(chips);
    set("apiKeys", chips.map((k) => k.id));
  };

  const freeCombos = combos.filter((c) => !comboNames.includes(c.name));
  const levelOptions = LEVELS.map((l) => ({ value: l, label: l }));

  return (
    <Card padding="md">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{translate("Adjust how hard the model thinks")}</h2>
          <p className="mt-1 text-sm text-text-muted">
            {translate("Sets the reasoning level turn by turn, so hard steps get more thinking and simple ones stop wasting tokens. Works with single models too, not only combos.")}
          </p>
        </div>
        <SegmentedControl options={MODES.map((m) => ({ ...m, label: translate(m.label) }))} value={config.mode} onChange={(v) => set("mode", v)} size="sm" />
      </div>

      <p className={`mt-4 rounded-md px-3 py-2 text-sm ${config.mode === "enforce" ? "bg-feedback-success-surface text-feedback-success-foreground" : config.mode === "shadow" ? "bg-feedback-info-surface text-feedback-info-foreground" : "bg-surface-2 text-text-muted"}`}>
        {reasoningAutopilotSummary(config)}
      </p>

      <div className="mt-5 flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{translate("Range")}</p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-text-muted">{translate("Between")}</span>
            <Select className="w-32" options={levelOptions} value={config.floor} onChange={(e) => setFloor(e.target.value)} aria-label={translate("Lowest level")} />
            <span className="text-text-muted">{translate("and")}</span>
            <Select className="w-32" options={levelOptions} value={config.ceiling} onChange={(e) => setCeiling(e.target.value)} aria-label={translate("Highest level")} />
          </div>
          <p className="text-xs text-text-muted">{translate("Never below the first for real work (session titles still get none), never above the second, whatever the client asks.")}</p>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">{translate("Applies to")}</p>
            <SegmentedControl
              options={SCOPES.map((s) => ({ ...s, label: translate(s.label) }))}
              value={config.all ? "all" : "chosen"}
              onChange={(v) => set("all", v === "all")}
              size="sm"
            />
          </div>
          {config.all ? (
            <p className="text-xs text-text-muted">{translate("Every request, local ones without a key included.")}</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-2">
                <p className="text-xs font-medium text-text-muted">{translate("API keys")}</p>
                <ApiKeyPicker selected={keyChips} onChange={setKeys} />
              </div>
              <div className="flex flex-col gap-2">
                <p className="text-xs font-medium text-text-muted">{translate("Combos")}</p>
                {comboNames.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {comboNames.map((name) => (
                      <span key={name} className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2.5 pr-1 text-xs text-primary">
                        {name}
                        <button type="button" onClick={() => set("combos", comboNames.filter((v) => v !== name))} className="grid size-5 place-items-center rounded-full hover:bg-primary/20" aria-label={`${translate("Remove")} ${name}`}>
                          <Icon name="close" size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {freeCombos.length > 0 ? (
                  <Select
                    placeholder={translate("Add a combo…")}
                    options={freeCombos.map((c) => ({ value: c.name, label: c.name }))}
                    value=""
                    onChange={(e) => e.target.value && set("combos", [...comboNames, e.target.value])}
                  />
                ) : comboNames.length === 0 && <p className="text-xs text-text-muted italic">{translate("No combos yet.")}</p>}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">{translate("Judge difficulty with the decision model")}</p>
            <p className="text-xs text-text-muted">
              {translate("Asks JEV once per message you send (reused across its tool steps). Off: built-in signals only, like plan mode and repeated tool errors.")}
            </p>
          </div>
          <Toggle size="sm" checked={config.askJevDirect !== false} onChange={() => set("askJevDirect", config.askJevDirect === false)} />
        </div>

        <p className="border-t border-border pt-3 text-xs text-text-muted">
          {translate("For developers: a request can opt out with the header x-red-router-reasoning: off, or force a level with x-red-router-reasoning: high (or any level).")}
        </p>
      </div>
    </Card>
  );
}
