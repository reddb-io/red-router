import { redirect } from "next/navigation";

const LEGACY_TAB_ROUTES: Record<string, string> = {
  advanced: "/system/settings/advanced",
  ai: "/system/settings/ai",
  appearance: "/system/settings/appearance",
  featureFlags: "/system/settings/feature-flags",
  "feature-flags": "/system/settings/feature-flags",
  cache: "/system/settings/cache",
  general: "/system/settings/storage",
  modalityBridge: "/system/settings/modality-bridge",
  "modality-bridge": "/system/settings/modality-bridge",
  resilience: "/system/settings/resilience",
  routing: "/system/settings/routing",
  security: "/system/settings/security",
  network: "/system/network",
  prompts: "/system/settings/prompts",
  sidebar: "/system/settings/sidebar",
};

type SettingsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function resolveSettingsRoute(value: string | undefined): string {
  return value
    ? LEGACY_TAB_ROUTES[value] || "/system/settings/storage"
    : "/system/settings/storage";
}

export default async function SettingsPage({ searchParams }: SettingsPageProps) {
  const params = searchParams ? await searchParams : {};
  const tab = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  redirect(resolveSettingsRoute(tab));
}
