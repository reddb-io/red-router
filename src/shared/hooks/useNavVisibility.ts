"use client";

import { useEffect, useState } from "react";
import {
  SIDEBAR_SETTINGS_UPDATED_EVENT,
  resolveHiddenSidebarItems,
} from "@/shared/constants/sidebarVisibility";
import { parseRadarAdminUrl } from "@/shared/validation/radarAdminUrl";

interface NavVisibility {
  hidden: ReadonlySet<string>;
  flags: Record<string, boolean>;
  radarAdmin: string | null;
}

const EMPTY: NavVisibility = { hidden: new Set(), flags: {}, radarAdmin: null };

/** What the menu hides for this operator, kept in step with Settings → Sidebar. */
export function useNavVisibility(): NavVisibility {
  const [visibility, setVisibility] = useState<NavVisibility>(EMPTY);

  useEffect(() => {
    const ctrl = new AbortController();
    let settings: Record<string, unknown> = {};
    const apply = (data: Record<string, unknown>) => {
      settings = { ...settings, ...data };
      setVisibility({
        hidden: new Set(resolveHiddenSidebarItems(settings)),
        flags:
          typeof settings.radarEnabled === "boolean"
            ? { RADAR_ENABLED: settings.radarEnabled }
            : {},
        radarAdmin: parseRadarAdminUrl(settings.radarAdminUrl ?? null),
      });
    };
    fetch("/api/settings", { signal: ctrl.signal })
      .then((res) => {
        if (!res.ok) throw new Error("Settings unavailable");
        return res.json();
      })
      .then((data) => {
        if (!ctrl.signal.aborted) apply({ ...data, ...settings });
      })
      .catch(() => {});
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      if (!detail) return;
      apply(detail);
    };
    window.addEventListener(SIDEBAR_SETTINGS_UPDATED_EVENT, onUpdated as EventListener);
    return () => {
      ctrl.abort();
      window.removeEventListener(SIDEBAR_SETTINGS_UPDATED_EVENT, onUpdated as EventListener);
    };
  }, []);

  return visibility;
}
