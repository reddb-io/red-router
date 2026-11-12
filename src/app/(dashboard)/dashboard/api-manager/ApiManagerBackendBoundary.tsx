"use client";

import { useEffect, useState } from "react";
import { readRustAuthConfig } from "@/lib/rustControlPlane/browserClient";
import ApiManagerPageClient from "./ApiManagerPageClient";
import RustApiManagerPageClient from "./RustApiManagerPageClient";

type Backend = "loading" | "legacy" | "rust";

export default function ApiManagerBackendBoundary() {
  const [backend, setBackend] = useState<Backend>("loading");

  useEffect(() => {
    const controller = new AbortController();
    void readRustAuthConfig(controller.signal)
      .then((config) => {
        if (!controller.signal.aborted) {
          setBackend(config?.control_plane_enabled ? "rust" : "legacy");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setBackend("legacy");
      });
    return () => controller.abort();
  }, []);

  if (backend === "loading") {
    return (
      <div className="p-6 text-sm text-text-muted" role="status">
        Detecting the active key authority…
      </div>
    );
  }
  return backend === "rust" ? <RustApiManagerPageClient /> : <ApiManagerPageClient />;
}
