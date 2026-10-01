"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import ThinkingBudgetTab from "../components/ThinkingBudgetTab";
import ModalityBridgeMovedCard from "../components/ModalityBridgeMovedCard";
import ResponsesStatePolicyTab from "../components/ResponsesStatePolicyTab";
import CodexFastTierTab from "../components/CodexFastTierTab";
import CodexAutoPingTab from "../components/CodexAutoPingTab";
import ClaudeFastModeTab from "../components/ClaudeFastModeTab";
import MemorySkillsTab from "../components/MemorySkillsTab";
import ModelsDevSyncTab from "../components/ModelsDevSyncTab";
import UsageTokenBufferTab from "../components/UsageTokenBufferTab";
import ModelCapabilityOverridesTab from "../components/ModelCapabilityOverridesTab";

export default function SettingsAiPage() {
  const t = useTranslations("settings");
  return (
    <div className="space-y-6">
      <p className="text-sm text-text-muted">{t("aiSettingsIntro")}</p>
      <ThinkingBudgetTab />
      <ModalityBridgeMovedCard />
      <p className="text-sm text-text-muted">
        Manage instructions added to chat requests in{" "}
        <Link href="/system/settings/prompts" className="text-primary hover:underline">
          Settings → Prompts
        </Link>
        .
      </p>
      <ResponsesStatePolicyTab />
      <UsageTokenBufferTab />
      <CodexFastTierTab />
      <CodexAutoPingTab />
      <ClaudeFastModeTab />
      <MemorySkillsTab />
      <ModelCapabilityOverridesTab />
      <ModelsDevSyncTab />
    </div>
  );
}
