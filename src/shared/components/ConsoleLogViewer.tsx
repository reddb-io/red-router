"use client";

import { useLocale, useTranslations } from "next-intl";

/**
 * Console Log Viewer — Real-time application log viewer.
 *
 * Displays structured application logs from the server with a terminal-like UI.
 * Polls the backend API every 5 seconds. Shows logs from the last 1 hour.
 * Supports level filtering, text search, auto-scroll, and copy-to-clipboard.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { copyToClipboard } from "@/shared/utils/clipboard";
import {
  bucketLogActivity,
  logActivityLevel,
  LOG_ACTIVITY_MINUTE_MS,
} from "@/shared/utils/logActivity";
import ConsoleLogActivity from "@/shared/components/ConsoleLogActivity";

interface LogEntry {
  timestamp: string;
  level: string;
  component?: string;
  module?: string;
  message?: string;
  msg?: string;
  correlationId?: string;
  [key: string]: unknown;
}

const LEVEL_COLORS: Record<string, string> = {
  debug: "text-gray-400",
  trace: "text-gray-500",
  info: "text-cyan-400",
  warn: "text-yellow-400",
  error: "text-red-400",
  fatal: "text-fuchsia-400",
};

const LEVEL_BG: Record<string, string> = {
  debug: "bg-gray-500/10 border-gray-500/20",
  trace: "bg-gray-500/10 border-gray-500/20",
  info: "bg-cyan-500/10 border-cyan-500/20",
  warn: "bg-yellow-500/10 border-yellow-500/20",
  error: "bg-red-500/10 border-red-500/20",
  fatal: "bg-fuchsia-500/10 border-fuchsia-500/20",
};

const POLL_INTERVAL = 5000; // 5 seconds
const PREFS_KEY = "rr.consoleLog.prefs";
const LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LEVELS)[number];
type ConsolePrefs = { timestamps: boolean; wrap: boolean; levels: LogLevel[] };
const DEFAULT_PREFS: ConsolePrefs = {
  timestamps: true,
  wrap: false,
  levels: [...LEVELS],
};

function readPrefs(): ConsolePrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") as Partial<ConsolePrefs>;
    return {
      timestamps: typeof saved.timestamps === "boolean" ? saved.timestamps : true,
      wrap: typeof saved.wrap === "boolean" ? saved.wrap : false,
      levels: Array.isArray(saved.levels)
        ? LEVELS.filter((level) => saved.levels?.includes(level))
        : [...LEVELS],
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export default function ConsoleLogViewer() {
  const locale = useLocale();
  const t = useTranslations("loggers");
  const tl = useTranslations("logs");
  const tv = useTranslations("logs.consoleViewer");
  const tc = useTranslations("common");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<ConsolePrefs>(DEFAULT_PREFS);
  const [searchText, setSearchText] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [selectedMinute, setSelectedMinute] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [fullScreenError, setFullScreenError] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logUpdateVersionRef = useRef(0);

  useEffect(() => {
    // Restore browser-only display settings after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPrefs(readPrefs());
  }, []);

  const updatePrefs = (patch: Partial<ConsolePrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // Private browsing can reject persistence; keep the current view usable.
      }
      return next;
    });
  };

  const fetchLogs = useCallback(async () => {
    const version = logUpdateVersionRef.current;
    try {
      const params = new URLSearchParams();
      params.set("limit", "500");

      const res = await fetch(`/api/logs/console?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: LogEntry[] = await res.json();
      if (version !== logUpdateVersionRef.current) return;

      setLogs(data);
      setLastUpdated(new Date());
      setError(null);
    } catch (err: any) {
      if (version !== logUpdateVersionRef.current) return;
      setError(err.message || tv("fetchFailed"));
    } finally {
      if (version === logUpdateVersionRef.current) setLoading(false);
    }
  }, [tv]);

  // The server sends one snapshot, then only appended lines. Polling remains a
  // fallback when EventSource is unavailable or the stream disconnects.
  useEffect(() => {
    logUpdateVersionRef.current += 1;
    let source: EventSource | null = null;
    let initialFetch: ReturnType<typeof setTimeout> | null = null;
    let fallbackDelay: ReturnType<typeof setTimeout> | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (interval) return;
      initialFetch = setTimeout(() => void fetchLogs(), 0);
      interval = setInterval(() => void fetchLogs(), POLL_INTERVAL);
    };
    const stopPolling = () => {
      if (initialFetch) clearTimeout(initialFetch);
      if (interval) clearInterval(interval);
      initialFetch = null;
      interval = null;
    };

    if (typeof EventSource === "undefined") {
      startPolling();
    } else {
      try {
        const params = new URLSearchParams();
        source = new EventSource(`/api/logs/console/stream?${params.toString()}`);
        source.onopen = () => {
          if (fallbackDelay) clearTimeout(fallbackDelay);
          fallbackDelay = null;
          stopPolling();
        };
        source.onmessage = (event) => {
          try {
            const update: unknown = JSON.parse(event.data);
            if (!update || typeof update !== "object") return;
            const payload = update as { type?: string; logs?: LogEntry[] };
            if (payload.type === "error") {
              setError(tv("fetchFailed"));
              source?.close();
              startPolling();
              return;
            }
            if (!Array.isArray(payload.logs)) return;
            logUpdateVersionRef.current += 1;
            const incoming = payload.logs;
            if (payload.type === "snapshot") setLogs(incoming);
            else if (payload.type === "append") {
              setLogs((previous) => [...previous, ...incoming].slice(-500));
            } else return;
            setLastUpdated(new Date());
            setLoading(false);
            setError(null);
          } catch {
            source?.close();
            startPolling();
          }
        };
        source.onerror = () => startPolling();
        fallbackDelay = setTimeout(startPolling, 3_000);
      } catch {
        startPolling();
      }
    }

    return () => {
      logUpdateVersionRef.current += 1;
      source?.close();
      if (fallbackDelay) clearTimeout(fallbackDelay);
      stopPolling();
    };
  }, [fetchLogs, tv]);

  useEffect(
    () => () => {
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
    },
    []
  );

  useEffect(() => {
    const initial = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const sync = () => setIsFullScreen(document.fullscreenElement === frameRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggleFullScreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (frameRef.current?.requestFullscreen) await frameRef.current.requestFullscreen();
      else throw new Error("Fullscreen API unavailable");
      setFullScreenError(false);
    } catch {
      setFullScreenError(true);
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Node) || !frameRef.current?.contains(target)) return;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, button, a, [contenteditable]")
      )
        return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        void toggleFullScreen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleFullScreen]);

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleConsoleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    setAutoScroll((current) => (current === atBottom ? current : atBottom));
  };

  const handleCopy = async (entry: LogEntry, idx: number) => {
    const text = JSON.stringify(entry, null, 2);
    const success = await copyToClipboard(text);
    if (!success) {
      setError(tv("copyFailed"));
      return;
    }

    setError(null);
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
    setCopiedAll(false);
    setCopiedIdx(idx);
    copyFeedbackTimerRef.current = setTimeout(() => {
      copyFeedbackTimerRef.current = null;
      setCopiedIdx(null);
      setCopiedAll(false);
    }, 2000);
  };

  const formatTime = (ts: string) => {
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString(locale, {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
      });
    } catch {
      return ts;
    }
  };

  const stringifyValue = (value: unknown) => {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return String(value);
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  const getText = (entry: LogEntry) => stringifyValue(entry.msg || entry.message || "");
  const getComponent = (entry: LogEntry) => stringifyValue(entry.component || entry.module || "");
  const getCorrelationId = (entry: LogEntry) => stringifyValue(entry.correlationId);

  // Apply text search filter
  const activityBuckets = useMemo(() => bucketLogActivity(logs, now), [logs, now]);
  const firstMinute = activityBuckets[0].start;
  const lastMinute = activityBuckets[activityBuckets.length - 1].start;
  const activeMinute =
    selectedMinute !== null && selectedMinute >= firstMinute && selectedMinute <= lastMinute
      ? selectedMinute
      : null;

  const filteredLogs = useMemo(() => {
    const query = searchText.toLowerCase();
    return logs.filter((entry) => {
      if (!prefs.levels.includes(logActivityLevel(entry))) return false;
      if (query && !JSON.stringify(entry).toLowerCase().includes(query)) return false;
      if (activeMinute === null) return true;
      const timestamp = new Date(entry.timestamp).getTime();
      return timestamp >= activeMinute && timestamp < activeMinute + LOG_ACTIVITY_MINUTE_MS;
    });
  }, [logs, searchText, activeMinute, prefs.levels]);

  const shownText = () =>
    filteredLogs
      .map((entry) => {
        const component = getComponent(entry);
        return [
          prefs.timestamps ? entry.timestamp : "",
          entry.level,
          component ? `[${component}]` : "",
          getText(entry),
        ]
          .filter(Boolean)
          .join(" ");
      })
      .join("\n");

  const handleCopyShown = async () => {
    const success = await copyToClipboard(shownText());
    if (!success) {
      setError(tv("copyFailed"));
      return;
    }
    setError(null);
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
    setCopiedIdx(null);
    setCopiedAll(true);
    copyFeedbackTimerRef.current = setTimeout(() => {
      copyFeedbackTimerRef.current = null;
      setCopiedAll(false);
    }, 2000);
  };

  const handleDownloadShown = () => {
    let url: string | null = null;
    let link: HTMLAnchorElement | null = null;
    try {
      url = URL.createObjectURL(new Blob([shownText()], { type: "text/plain;charset=utf-8" }));
      link = document.createElement("a");
      link.href = url;
      link.download = `omniroute-console-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
      document.body.appendChild(link);
      link.click();
      setError(null);
    } catch {
      setError(tl("exportFailed"));
    } finally {
      link?.remove();
      if (url) URL.revokeObjectURL(url);
    }
  };

  return (
    <div
      ref={frameRef}
      className={`flex flex-col gap-4 ${isFullScreen ? "h-screen min-h-0 bg-[var(--color-bg)] p-3" : ""}`}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 p-4 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]">
        <div role="group" aria-label={tv("filterByLevel")} className="flex flex-wrap gap-1">
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={prefs.levels.includes(level)}
              onClick={() =>
                updatePrefs({
                  levels: prefs.levels.includes(level)
                    ? prefs.levels.filter((selected) => selected !== level)
                    : [...prefs.levels, level],
                })
              }
              className={`rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-main)] ${prefs.levels.includes(level) ? "opacity-100" : "opacity-50"}`}
            >
              {level}
            </button>
          ))}
        </div>

        {/* Search */}
        <input
          ref={searchRef}
          type="text"
          placeholder={tv("searchPlaceholder")}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          aria-label={tv("searchAria")}
          className="flex-1 min-w-[200px] px-3 py-2 rounded-lg text-sm bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-main)] placeholder:text-[var(--color-text-muted)] focus:outline-2 focus:outline-[var(--color-accent)]"
        />

        {/* Auto-scroll toggle */}
        <button
          onClick={() => setAutoScroll(!autoScroll)}
          aria-pressed={autoScroll}
          title={autoScroll ? tv("disableAutoScroll") : tv("enableAutoScroll")}
          className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
            autoScroll
              ? "bg-cyan-500/15 text-cyan-400 border-cyan-500/30"
              : "bg-[var(--color-bg)] text-[var(--color-text-muted)] border-[var(--color-border)]"
          }`}
        >
          <span className="material-symbols-outlined text-[16px] align-middle mr-1">
            {autoScroll ? "vertical_align_bottom" : "lock"}
          </span>
          {tv("autoScroll")}
        </button>

        <button
          type="button"
          aria-label="Show timestamps"
          aria-pressed={prefs.timestamps}
          onClick={() => updatePrefs({ timestamps: !prefs.timestamps })}
          className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-main)]"
        >
          Time
        </button>
        <button
          type="button"
          aria-label="Wrap long lines"
          aria-pressed={prefs.wrap}
          onClick={() => updatePrefs({ wrap: !prefs.wrap })}
          className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-main)]"
        >
          Wrap
        </button>

        {/* Refresh */}
        <button
          onClick={fetchLogs}
          disabled={loading}
          aria-label={tc("refresh")}
          className="px-3 py-2 rounded-lg text-sm font-medium bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] disabled:opacity-50 transition-colors"
        >
          <span className="material-symbols-outlined text-[16px] align-middle" aria-hidden="true">
            refresh
          </span>
        </button>

        <button
          type="button"
          onClick={() => void toggleFullScreen()}
          aria-label={isFullScreen ? "Exit full screen" : "Full screen"}
          title={isFullScreen ? "Exit full screen (Esc)" : "Full screen (F)"}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
            {isFullScreen ? "fullscreen_exit" : "fullscreen"}
          </span>
        </button>

        <div className="flex items-center gap-1" role="group" aria-label={tv("consoleAria")}>
          <button
            type="button"
            onClick={() => void handleCopyShown()}
            disabled={filteredLogs.length === 0}
            aria-label={tc("copy")}
            title={tc("copy")}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              {copiedAll ? "check" : "content_copy"}
            </span>
          </button>
          <button
            type="button"
            onClick={handleDownloadShown}
            disabled={filteredLogs.length === 0}
            aria-label={tl("export")}
            title={tl("export")}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-text-main)] hover:bg-[var(--color-bg-alt)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              download
            </span>
          </button>
        </div>
        {copiedAll && (
          <span className="sr-only" role="status" aria-live="polite">
            {tc("copied")}
          </span>
        )}

        {/* Status */}
        <div className="flex items-center gap-2 ml-auto text-xs text-[var(--color-text-muted)]">
          <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span>{tv("entryCount", { count: filteredLogs.length })}</span>
          <span className="text-[var(--color-text-muted)]/50">•</span>
          <span>{tv("lastHour")}</span>
          {lastUpdated && (
            <>
              <span className="text-[var(--color-text-muted)]/50">•</span>
              <span>{tv("updatedAt", { time: lastUpdated.toLocaleTimeString(locale) })}</span>
            </>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div
          className="p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm"
          role="alert"
        >
          <span className="material-symbols-outlined text-[16px] align-middle mr-2">error</span>
          {error}
          <span className="text-xs ml-2 opacity-70">— {tv("fileLoggingRequired")}</span>
        </div>
      )}

      {fullScreenError && (
        <p role="alert" className="text-sm text-red-400">
          Full screen is unavailable in this browser.
        </p>
      )}

      {now > 0 ? (
        <ConsoleLogActivity
          buckets={activityBuckets}
          selectedMinute={activeMinute}
          onSelectMinute={setSelectedMinute}
          locale={locale}
          warningLabel={tc("warning")}
          errorLabel={tc("errors")}
        />
      ) : (
        <div className="h-20 rounded-xl bg-[var(--color-surface)]" aria-hidden="true" />
      )}

      {/* Console output */}
      <div
        ref={scrollRef}
        onScroll={handleConsoleScroll}
        className={`rounded-xl border border-[var(--color-border)] bg-[#0d1117] overflow-auto font-mono text-xs leading-relaxed ${isFullScreen ? "min-h-0 flex-1" : ""}`}
        style={isFullScreen ? undefined : { maxHeight: "calc(100vh - 340px)", minHeight: "400px" }}
        role="log"
        aria-label={tv("consoleAria")}
        aria-live="polite"
      >
        {/* Header bar */}
        <div className="sticky top-0 z-10 px-4 py-2 bg-[#161b22] border-b border-[#30363d] flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-[#FF5F56]" />
          <div className="w-3 h-3 rounded-full bg-[#FFBD2E]" />
          <div className="w-3 h-3 rounded-full bg-[#27C93F]" />
          <span className="ml-3 text-[#8b949e] text-[11px]">
            OmniRoute — {tv("applicationConsole")}
          </span>
        </div>

        {/* Log entries */}
        <div className="p-3 space-y-px">
          {filteredLogs.length === 0 && !loading ? (
            <div className="text-[#8b949e] text-center py-12">
              <span className="material-symbols-outlined text-[40px] block mb-2 opacity-30">
                terminal
              </span>
              <p>{t("noLogEntries")}</p>
              <p className="text-[10px] mt-1 opacity-60">{tv("emptyFileLoggingHint")}</p>
            </div>
          ) : (
            filteredLogs.map((entry, idx) => {
              const level = stringifyValue(entry.level || "info").toLowerCase();
              const colorClass = LEVEL_COLORS[level] || LEVEL_COLORS.info;
              const bgClass = LEVEL_BG[level] || "";
              const comp = getComponent(entry);
              const msg = getText(entry);
              const correlationId = getCorrelationId(entry);

              return (
                <div
                  key={idx}
                  className={`group flex items-start gap-2 px-2 py-1 rounded hover:bg-white/5 transition-colors ${
                    level === "error" || level === "fatal" ? "bg-red-500/5" : ""
                  }`}
                >
                  {/* Timestamp */}
                  {prefs.timestamps && (
                    <span className="text-[#484f58] whitespace-nowrap shrink-0 select-none">
                      {formatTime(entry.timestamp)}
                    </span>
                  )}

                  {/* Level badge */}
                  <span
                    className={`inline-block px-1.5 py-0 rounded text-[10px] font-semibold uppercase border shrink-0 ${colorClass} ${bgClass}`}
                  >
                    {level.padEnd(5)}
                  </span>

                  {/* Component */}
                  {comp && <span className="text-purple-400/80 shrink-0">[{comp}]</span>}

                  {/* Message */}
                  <span
                    className={`text-[#c9d1d9] flex-1 ${prefs.wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}
                  >
                    {msg}
                    {/* Extra meta */}
                    {correlationId && (
                      <span className="text-[#484f58] ml-2">cid:{correlationId.slice(0, 8)}</span>
                    )}
                  </span>

                  {/* Copy button */}
                  <button
                    onClick={() => handleCopy(entry, idx)}
                    title={tv("copyLogEntry")}
                    aria-label={tv("copyLogEntry")}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity shrink-0 text-[#8b949e] hover:text-white"
                  >
                    <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                      {copiedIdx === idx ? "check" : "content_copy"}
                    </span>
                  </button>
                  {copiedIdx === idx && (
                    <span className="sr-only" role="status" aria-live="polite">
                      {tc("copied")}
                    </span>
                  )}
                </div>
              );
            })
          )}

          {loading && filteredLogs.length === 0 && (
            <div className="text-[#8b949e] text-center py-12">
              <span className="material-symbols-outlined text-[24px] animate-spin block mb-2">
                progress_activity
              </span>
              {t("loadingLogs")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
