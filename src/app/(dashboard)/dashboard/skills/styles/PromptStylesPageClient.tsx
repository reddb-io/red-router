"use client";

// Prompt styles — the instructions RedRouter adds to the system prompt so replies come back terse
// or in a set voice (Caveman, Ponytail and the other output styles). They change what the model
// writes, not what is sent, so they work with any provider. The compression engines that shrink
// the request live in Token saver.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
// Direct module paths (not the @/shared/components barrel), as in CompressionPanel.
import Card from "@/shared/components/Card";
import Toggle from "@/shared/components/Toggle";
import {
  OUTPUT_STYLE_IDS,
  outputStyleMeta,
} from "../../../../../../open-sse/services/compression/outputStyles/catalog.ts";

type Level = "lite" | "full" | "ultra";
const LEVELS: Level[] = ["lite", "full", "ultra"];

interface OutputMode {
  enabled: boolean;
  intensity: Level;
  autoClarity: boolean;
}

interface StyleSelection {
  id: string;
  level: Level;
}

interface StylesConfig {
  cavemanOutputMode: OutputMode;
  outputStyles: StyleSelection[];
}

const DEFAULTS: StylesConfig = {
  cavemanOutputMode: { enabled: false, intensity: "full", autoClarity: true },
  outputStyles: [],
};

export default function PromptStylesPageClient() {
  const t = useTranslations("settings");
  const [config, setConfig] = useState<StylesConfig>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"" | "saved" | "error">("");
  const confirmed = useRef<StylesConfig>(DEFAULTS);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/compression")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Partial<StylesConfig> | null) => {
        if (cancelled || !data) return;
        const loaded: StylesConfig = {
          cavemanOutputMode: { ...DEFAULTS.cavemanOutputMode, ...(data.cavemanOutputMode ?? {}) },
          outputStyles: data.outputStyles ?? [],
        };
        confirmed.current = loaded;
        setConfig(loaded);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (patch: Partial<StylesConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    setSaving(true);
    setStatus("");
    try {
      const res = await fetch("/api/settings/compression", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        confirmed.current = next;
        setStatus("saved");
      } else {
        setConfig(confirmed.current);
        setStatus("error");
      }
    } catch {
      setConfig(confirmed.current);
      setStatus("error");
    } finally {
      setSaving(false);
    }
  };

  const setStyle = (id: string, patch: { enabled?: boolean; level?: Level }) => {
    const existing = config.outputStyles.find((style) => style.id === id);
    let next = config.outputStyles;
    if (patch.enabled === false) {
      next = next.filter((style) => style.id !== id);
    } else {
      const level = patch.level ?? existing?.level ?? "full";
      next = existing
        ? next.map((style) => (style.id === id ? { id, level } : style))
        : [...next, { id, level }];
    }
    // Catalog order keeps the injection order stable.
    const ordered = OUTPUT_STYLE_IDS.flatMap((styleId) => next.filter((s) => s.id === styleId));
    void save({ outputStyles: ordered });
  };

  const caveman = config.cavemanOutputMode;

  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-3xl">
        <h1 className="text-lg font-semibold text-text-main">Prompt styles</h1>
        <p className="mt-1 text-sm text-text-muted">
          Instructions added to the system prompt so replies come back terse or in a set voice. They
          change what the model writes, not what is sent, so they work with any provider. The
          engines that shrink the request itself are in{" "}
          <Link href="/dashboard/context/settings" className="text-primary hover:underline">
            Token saver
          </Link>
          .
        </p>
      </div>

      <Card>
        <div className="flex flex-col gap-3" aria-busy={loading}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-main">Caveman</p>
              <p className="text-xs text-text-muted">
                Answers in clipped, filler-free sentences. Clarity mode switches it off for warnings
                and destructive steps.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <select
                aria-label="Caveman level"
                value={caveman.intensity}
                disabled={!caveman.enabled || saving}
                onChange={(event) =>
                  void save({
                    cavemanOutputMode: { ...caveman, intensity: event.target.value as Level },
                  })
                }
                className="w-28 rounded border border-border bg-surface px-2 py-1 text-xs text-text-main"
              >
                {LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {t(`compressionLevel.${level}`)}
                  </option>
                ))}
              </select>
              <Toggle
                size="sm"
                checked={caveman.enabled}
                onChange={(enabled) => void save({ cavemanOutputMode: { ...caveman, enabled } })}
                disabled={saving}
                ariaLabel="Caveman"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={caveman.autoClarity}
              disabled={!caveman.enabled || saving}
              onChange={(event) =>
                void save({ cavemanOutputMode: { ...caveman, autoClarity: event.target.checked } })
              }
            />
            Clarity mode
          </label>

          <div className="mt-1 flex flex-col gap-3 border-t border-border/30 pt-3">
            {OUTPUT_STYLE_IDS.filter((id) => {
              const meta = outputStyleMeta(id);
              return !meta?.locale || meta.locale === "en";
            }).map((id) => {
              const selected = config.outputStyles.find((style) => style.id === id);
              const label = t(`compressionOutputStyle.${id}.label`);
              return (
                <div
                  key={id}
                  data-testid={`prompt-style-row-${id}`}
                  className="flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-text-main">{label}</p>
                    <p className="text-xs text-text-muted">
                      {t(`compressionOutputStyle.${id}.description`)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <select
                      aria-label={`${label} level`}
                      value={selected?.level ?? "full"}
                      disabled={!selected || saving}
                      onChange={(event) => setStyle(id, { level: event.target.value as Level })}
                      className="w-28 rounded border border-border bg-surface px-2 py-1 text-xs text-text-main"
                    >
                      {LEVELS.map((level) => (
                        <option key={level} value={level}>
                          {t(`compressionLevel.${level}`)}
                        </option>
                      ))}
                    </select>
                    <Toggle
                      size="sm"
                      checked={Boolean(selected)}
                      onChange={(enabled) => setStyle(id, { enabled })}
                      disabled={saving}
                      ariaLabel={label}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <p role="status" className="min-h-4 text-xs text-text-muted">
            {status === "saved" && "Saved"}
            {status === "error" && "Could not save. The previous setting is back."}
          </p>
        </div>
      </Card>
    </div>
  );
}
