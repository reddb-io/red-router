"use client";

import { useEffect, useState } from "react";
import {
  HIDDEN_SIDEBAR_ITEMS_SETTING_KEY,
  SIDEBAR_SETTINGS_UPDATED_EVENT,
  normalizeHiddenSidebarItems,
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
    let cancelled = false;
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setVisibility({
          hidden: new Set(normalizeHiddenSidebarItems(data?.[HIDDEN_SIDEBAR_ITEMS_SETTING_KEY])),
          flags:
            typeof data?.radarEnabled === "boolean" ? { RADAR_ENABLED: data.radarEnabled } : {},
          radarAdmin: parseRadarAdminUrl(data?.radarAdminUrl ?? null),
        });
      })
      .catch(() => {});

    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail || {};
      if (HIDDEN_SIDEBAR_ITEMS_SETTING_KEY in detail) {
        setVisibility((prev) => ({
          ...prev,
          hidden: new Set(normalizeHiddenSidebarItems(detail[HIDDEN_SIDEBAR_ITEMS_SETTING_KEY])),
        }));
      }
    };
    window.addEventListener(SIDEBAR_SETTINGS_UPDATED_EVENT, onUpdated as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener(SIDEBAR_SETTINGS_UPDATED_EVENT, onUpdated as EventListener);
    };
  }, []);

  return visibility;
}
