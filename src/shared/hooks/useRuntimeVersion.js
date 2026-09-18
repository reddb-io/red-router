import { useEffect, useState } from "react";
import { APP_CONFIG } from "@/shared/constants/config";

// Runtime truth for the displayed app version: /api/version reads the
// package.json of the RUNNING server, so the UI never shows a stale
// build-time constant. Falls back to the bundled APP_CONFIG.version.
export function useRuntimeVersion() {
  const [version, setVersion] = useState(APP_CONFIG.version);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/version")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data?.currentVersion) setVersion(data.currentVersion);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return version;
}
