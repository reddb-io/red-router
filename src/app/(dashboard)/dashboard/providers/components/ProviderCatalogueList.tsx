"use client";

import { useTranslations } from "next-intl";
import Button from "@/shared/components/Button";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { providerText } from "../providerText";
import { getProviderCatalogueMeta, isProviderEntryEnabled } from "../providerView";
import type { ProviderAvailabilityMap } from "../providerView";
import { resolveDashboardProviderInfo } from "../providerPageUtils";
import type { ProviderEntry } from "../providerPageUtils";
import { NeutralTag } from "./NeutralTag";

interface CatalogueProvider {
  id?: string;
  name?: string;
  iconUrl?: string;
  textIcon?: string;
}

interface ProviderCatalogueListProps {
  entries: ProviderEntry<CatalogueProvider>[];
  availability: ProviderAvailabilityMap | null | undefined;
  /** Opens the provider's page, where connections are added (the existing add flow). */
  onOpenProvider: (providerId: string) => void;
}

/**
 * The catalogue of everything RedRouter can route to, as one dense, searchable list. Nothing here
 * is enabled by being listed: "Add" opens the provider's page, where the connection is created.
 */
export default function ProviderCatalogueList({
  entries,
  availability,
  onOpenProvider,
}: ProviderCatalogueListProps) {
  const t = useTranslations("providers");

  if (entries.length === 0) {
    return (
      <div
        className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-text-muted"
        data-testid="provider-catalogue-empty"
      >
        {providerText(t, "noProvidersMatch", "No providers match your search.")}
      </div>
    );
  }

  return (
    <div
      className="overflow-x-auto rounded-xl border border-border"
      data-testid="provider-catalogue"
    >
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead className="border-b border-border text-xs text-text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              {providerText(t, "catalogueColumnProvider", "Provider")}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {providerText(t, "catalogueColumnCategory", "Category")}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {providerText(t, "catalogueColumnAuth", "Auth")}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {providerText(t, "catalogueColumnStatus", "Status")}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              <span className="sr-only">{providerText(t, "catalogueColumnAction", "Action")}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {entries.map((entry) => {
            const name = entry.provider.name || entry.providerId;
            const meta = getProviderCatalogueMeta(
              entry,
              resolveDashboardProviderInfo(entry.providerId)?.category
            );
            const enabled = isProviderEntryEnabled(entry, availability);
            return (
              <tr key={entry.providerId} data-testid={`provider-catalogue-row-${entry.providerId}`}>
                <td className="px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <ProviderIcon
                      providerId={entry.provider.id || entry.providerId}
                      src={entry.provider.iconUrl}
                      alt={name}
                      size={20}
                      type="color"
                      fallbackText={entry.provider.textIcon}
                    />
                    <span className="truncate font-medium text-text-main">{name}</span>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <NeutralTag>{meta.categoryLabel}</NeutralTag>
                </td>
                <td className="px-3 py-2">
                  <NeutralTag>{meta.authLabel}</NeutralTag>
                </td>
                <td className="px-3 py-2">
                  {enabled ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-feedback-success-foreground">
                      <span
                        className="size-1.5 rounded-full bg-feedback-success-foreground"
                        aria-hidden="true"
                      />
                      {providerText(t, "catalogueEnabled", "Enabled")}
                    </span>
                  ) : (
                    <span className="text-xs text-text-muted">
                      {providerText(t, "catalogueNotEnabled", "Not enabled")}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    size="sm"
                    variant={enabled ? "ghost" : "secondary"}
                    icon={enabled ? undefined : "add"}
                    onClick={() => onOpenProvider(entry.providerId)}
                    aria-label={
                      enabled
                        ? providerText(t, "catalogueManageAria", "Manage {name}", { name })
                        : providerText(t, "catalogueAddAria", "Add {name}", { name })
                    }
                  >
                    {enabled
                      ? providerText(t, "catalogueManage", "Manage")
                      : providerText(t, "catalogueAdd", "Add")}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
