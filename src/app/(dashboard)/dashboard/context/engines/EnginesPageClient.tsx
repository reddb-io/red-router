"use client";

// Engines — every compression engine at a glance, linking to its own page. The Token saver entry
// shows this one tab instead of one tab per engine.
import Link from "next/link";
import { useEffect, useState } from "react";
// Direct module paths (not the @/shared/components barrel), as in CompressionPanel.
import Badge from "@/shared/components/Badge";
import Card from "@/shared/components/Card";
import {
  ENGINE_IDS,
  engineMeta,
} from "../../../../../../open-sse/services/compression/engineCatalog.ts";

/** Engines with a page of their own under /dashboard/context/<id>. */
const ENGINE_PAGES = new Set([
  "caveman",
  "rtk",
  "headroom",
  "session-dedup",
  "ccr",
  "llmlingua",
  "lite",
  "aggressive",
  "ultra",
  "omniglyph",
]);

interface EngineState {
  enabled?: boolean;
  level?: string;
}

export default function EnginesPageClient() {
  const [engines, setEngines] = useState<Record<string, EngineState> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/compression")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { engines?: Record<string, EngineState> } | null) => {
        if (!cancelled && data) setEngines(data.engines ?? {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-3xl">
        <h1 className="text-lg font-semibold text-text-main">Engines</h1>
        <p className="mt-1 text-sm text-text-muted">
          The compression engines RedRouter can apply to a request before it goes upstream. Turn
          them on and choose their level in{" "}
          <Link href="/dashboard/context/settings" className="text-primary hover:underline">
            Overview
          </Link>
          ; open an engine here for its own settings and numbers.
        </p>
      </div>

      <ul className="grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2 xl:grid-cols-3">
        {ENGINE_IDS.map((id) => {
          const meta = engineMeta(id);
          if (!meta) return null;
          const state = engines?.[id];
          const hasPage = ENGINE_PAGES.has(id);
          const body = (
            <Card padding="sm" hover={hasPage} className="h-full">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-text-main">{meta.label}</p>
                {state && (
                  <Badge variant={state.enabled ? "success" : "default"} size="sm">
                    {state.enabled ? (state.level ?? "On") : "Off"}
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-text-muted">{meta.description}</p>
              <p className="mt-2 text-xs text-text-muted">
                {meta.guidance.lossy ? "Lossy" : "Lossless"} · cache impact{" "}
                {meta.guidance.cacheImpact}
              </p>
            </Card>
          );
          return (
            <li key={id} data-testid={`engine-card-${id}`}>
              {hasPage ? (
                <Link
                  href={`/dashboard/context/${id}`}
                  prefetch={false}
                  className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  {body}
                </Link>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
