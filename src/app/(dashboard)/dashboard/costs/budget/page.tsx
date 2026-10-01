"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { tabs } from "@/shared/design-system/contracts/tabs.variants";
import BudgetTab from "../../usage/components/BudgetTab";
import AttributionRollup from "./AttributionRollup";
import BudgetsTable from "./BudgetsTable";

type TabValue = "budgets" | "per-key";

export default function CostsBudgetPage() {
  const t = useTranslations("budgets");
  const [active, setActive] = useState<TabValue>("budgets");
  const styles = tabs();
  const items: { value: TabValue; label: string }[] = [
    { value: "budgets", label: t("tabBudgets") },
    { value: "per-key", label: t("tabPerKey") },
  ];

  return (
    <div className={styles.root()}>
      <p className="mb-4 max-w-prose text-sm text-text-muted">
        USD caps include recorded costs and estimated reservations for calls in flight. Final
        provider charges can differ from estimates. Subscription providers are exempt from USD caps,
        but still count toward RPM and TPM limits. Unavailable budget policy blocks new calls.
      </p>
      <div role="tablist" aria-label={t("tabsLabel")} className={styles.list()}>
        {items.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={`budget-tab-${item.value}`}
            aria-selected={active === item.value}
            aria-controls={`budget-panel-${item.value}`}
            data-state={active === item.value ? "active" : "inactive"}
            className={styles.trigger()}
            onClick={() => setActive(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`budget-panel-${active}`}
        aria-labelledby={`budget-tab-${active}`}
        className={styles.content()}
      >
        {active === "budgets" ? (
          <div className="flex min-w-0 flex-col gap-8">
            <BudgetsTable />
            <AttributionRollup />
          </div>
        ) : (
          <BudgetTab />
        )}
      </div>
    </div>
  );
}
