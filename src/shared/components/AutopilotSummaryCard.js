"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { translate } from "@/i18n/runtime";
import Card from "./Card";
import Icon from "./Icon";

const LABEL = { off: "Off", shadow: "Test run", enforce: "On" };
const TONE = {
  off: "bg-surface-2 text-text-muted",
  shadow: "bg-feedback-info-surface text-feedback-info-foreground",
  enforce: "bg-feedback-success-surface text-feedback-success-foreground",
};

function Status({ label, mode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className="text-text-muted">{translate(label)}</span>
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE[mode] || TONE.off}`}>{translate(LABEL[mode] || "Off")}</span>
    </span>
  );
}

/** Where the Autopilot stands, with a link to its page (Combos). */
export default function AutopilotSummaryCard() {
  const [settings, setSettings] = useState(null);
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then(setSettings)
      .catch(() => {});
  }, []);
  if (!settings) return null;
  return (
    <Card padding="md">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Icon name="auto_awesome" size={20} className="shrink-0 text-primary" />
          <div className="min-w-0">
            <p className="font-medium">{translate("Autopilot")}</p>
            <p className="text-xs text-text-muted">{translate("A decision model can pick the combo member and the reasoning level for each turn.")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Status label="Model choice" mode={settings.decisionRouter?.mode} />
          <Status label="Reasoning" mode={settings.reasoningAutopilot?.mode} />
          <Link href="/dashboard/autopilot" className="text-sm font-medium text-primary hover:underline">{translate("Configure")} →</Link>
        </div>
      </div>
    </Card>
  );
}
