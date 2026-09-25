"use client";

import { useEffect, useState } from "react";
import { Card, Select, SegmentedControl, Toggle } from "@/shared/components";
import { translate } from "@/i18n/runtime";
import Icon from "./Icon";

// Same three states as the decision router: shadow logs the level it would pick
// (Usage → request details, X-RedRouter-Reasoning header) without touching the
// request, which is how the effect is measured before it is enforced.
const MODES = [
  { value: "off", label: "Off", desc: "Reasoning is exactly what the client asked for." },
  { value: "shadow", label: "Shadow", desc: "Picks and logs a level per turn. Applies nothing." },
  { value: "enforce", label: "Enforce", desc: "Raises and lowers the reasoning level when the human writes, within the floor and ceiling. Clients can also opt a request in with x-red-router-reasoning: auto." },
];

const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

function Chips({ values, labelOf, onRemove, empty }) {
  if (values.length === 0) return <span className="text-xs text-text-muted italic">{empty}</span>;
  return (
    <div className="flex flex-wrap gap-2">
      {values.map((value) => (
        <span key={value} className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5">
          <span className="font-mono text-xs text-text-muted">{labelOf(value)}</span>
          <button
            type="button"
            onClick={() => onRemove(value)}
            className="leading-none text-text-muted hover:text-feedback-danger-foreground"
            aria-label={`${translate("Remove")} ${labelOf(value)}`}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

export default function ReasoningAutopilotCard() {
  const [config, setConfig] = useState(null);
  const [keys, setKeys] = useState([]);
  const [combos, setCombos] = useState([]);

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data?.reasoningAutopilot) setConfig(data.reasoningAutopilot); })
      .catch(() => {});
    fetch("/api/keys", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setKeys(data?.keys || []))
      .catch(() => {});
    fetch("/api/combos", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setCombos(data?.combos || []))
      .catch(() => {});
  }, []);

  if (!config) return null;

  const activeMode = MODES.find((m) => m.value === config.mode) || MODES[0];
  const apiKeys = config.apiKeys || [];
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

  const keyName = (id) => keys.find((k) => k.id === id)?.name || id;
  const freeKeys = keys.filter((k) => !apiKeys.includes(k.id));
  const freeCombos = combos.filter((c) => !comboNames.includes(c.name));
  const levelOptions = LEVELS.map((l) => ({ value: l, label: l }));

  return (
    <Card padding="sm">
      <h2 className="text-base font-semibold mb-1">{translate("Reasoning autopilot")}</h2>
      <p className="text-xs text-text-muted mb-4">
        {translate("Sets how much the model thinks on each turn: more for hard steps, plan mode and stuck tool loops, less for mechanical steps and session titles. Works with direct models too, not only combos.")}
      </p>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <SegmentedControl options={MODES} value={config.mode} onChange={(v) => set("mode", v)} size="sm" />
          <p className="text-xs text-text-muted">{translate(activeMode.desc)}</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            label={translate("Floor")}
            options={levelOptions}
            value={config.floor}
            onChange={(e) => setFloor(e.target.value)}
            hint={translate("Never below this for real work. Session titles still go to none.")}
          />
          <Select
            label={translate("Ceiling")}
            options={levelOptions}
            value={config.ceiling}
            onChange={(e) => setCeiling(e.target.value)}
            hint={translate("Never above this, whatever the client or the verdict asks.")}
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">{translate("Every request")}</p>
            <Toggle size="sm" checked={config.all === true} onChange={() => set("all", config.all !== true)} />
          </div>
          <p className="text-xs text-text-muted">
            {translate("Off: only the API keys and combos below. On: every request, including local ones without a key.")}
          </p>
        </div>

        {!config.all && (
          <>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">{translate("API keys")}</p>
              <Chips
                values={apiKeys}
                labelOf={keyName}
                onRemove={(id) => set("apiKeys", apiKeys.filter((v) => v !== id))}
                empty={translate("No API key selected.")}
              />
              {freeKeys.length > 0 && (
                <Select
                  placeholder={translate("Add an API key…")}
                  options={freeKeys.map((k) => ({ value: k.id, label: k.name || k.id }))}
                  value=""
                  onChange={(e) => e.target.value && set("apiKeys", [...apiKeys, e.target.value])}
                />
              )}
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">{translate("Combos")}</p>
              <Chips
                values={comboNames}
                labelOf={(name) => name}
                onRemove={(name) => set("combos", comboNames.filter((v) => v !== name))}
                empty={translate("No combo selected.")}
              />
              {freeCombos.length > 0 && (
                <Select
                  placeholder={translate("Add a combo…")}
                  options={freeCombos.map((c) => ({ value: c.name, label: c.name }))}
                  value=""
                  onChange={(e) => e.target.value && set("combos", [...comboNames, e.target.value])}
                />
              )}
            </div>
          </>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">{translate("Ask the decision model")}</p>
            <Toggle size="sm" checked={config.askJevDirect !== false} onChange={() => set("askJevDirect", config.askJevDirect === false)} />
          </div>
          <p className="text-xs text-text-muted">
            {translate("One question per new request from the user, reused across its tool steps. Auto combos reuse their routing verdict instead. Off: deterministic signals and the client's own level only.")}
          </p>
        </div>

        <p className="text-xs text-text-muted">
          {translate("Per request: header x-red-router-reasoning: off keeps the client's level; a level (low, high…) forces it.")}
        </p>
      </div>
    </Card>
  );
}
