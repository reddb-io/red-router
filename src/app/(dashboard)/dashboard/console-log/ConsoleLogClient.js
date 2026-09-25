"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, Button, Input, Icon } from "@/shared/components";
import { cn } from "@/shared/utils/cn";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";

// Live server console: tail with auto-follow, text/regex filter, level chips,
// timestamps and wrapping on or off, copy and download of what is shown.
const LEVELS = [
  { id: "info", label: "Info", tone: "text-text-main" },
  { id: "warn", label: "Warn", tone: "text-feedback-warning-foreground" },
  { id: "error", label: "Error", tone: "text-feedback-danger-foreground" },
  { id: "debug", label: "Debug", tone: "text-text-muted" },
];
const TONE = Object.fromEntries(LEVELS.map((l) => [l.id, l.tone]));
const PREFS_KEY = "rr.consoleLog.prefs";
const DEFAULT_PREFS = { timestamps: true, wrap: false, levels: ["info", "warn", "error", "debug"] };
// The server's own "[13:19:58]" prefix is dropped when the timestamp column shows.
const CLOCK_PREFIX = /^\[\d{2}:\d{2}:\d{2}\]\s*/;

function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch {
    return DEFAULT_PREFS;
  }
}

// Older servers sent plain strings.
const toEntry = (e, i) => (typeof e === "string" ? { id: `s${i}-${e.length}`, t: null, level: "info", text: e } : e);

// Warnings and errors that reach console.log still read as what they are.
function levelOf(entry) {
  if (entry.level !== "info") return entry.level;
  if (/⚠️|\bWARN\b/.test(entry.text)) return "warn";
  if (/❌|🔴|\bERROR\b|\bError:/.test(entry.text)) return "error";
  return "info";
}

function formatTime(t) {
  if (!t) return "";
  const d = new Date(t);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** A filter string as a matcher: /regex/flags or a case-insensitive substring. */
function buildMatcher(query) {
  const q = query.trim();
  if (!q) return { test: () => true, regex: null, error: null };
  const re = q.match(/^\/(.+)\/([gimsuy]*)$/);
  try {
    const regex = re ? new RegExp(re[1], re[2].includes("i") ? re[2] : `${re[2]}i`) : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    return { test: (s) => { regex.lastIndex = 0; return regex.test(s); }, regex, error: null };
  } catch (e) {
    return { test: () => true, regex: null, error: e.message };
  }
}

function Highlighted({ text, regex }) {
  if (!regex) return text;
  const global = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(global)) {
    if (!m[0]) break;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<mark key={m.index} className="rounded-sm bg-feedback-warning-surface text-feedback-warning-foreground">{m[0]}</mark>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export default function ConsoleLogClient() {
  const [entries, setEntries] = useState([]);
  const [connected, setConnected] = useState(false);
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [query, setQuery] = useState("");
  const [following, setFollowing] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [copied, setCopied] = useState(false);
  const logRef = useRef(null);
  const followingRef = useRef(true);

  useEffect(() => {
    // Per-viewer display preferences, restored after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPrefs(loadPrefs());
  }, []);

  const updatePrefs = (patch) => setPrefs((prev) => {
    const next = { ...prev, ...patch };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });

  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");
    const append = (incoming) => {
      setEntries((prev) => {
        const next = [...prev, ...incoming];
        return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
      });
      if (!followingRef.current) setUnseen((n) => n + incoming.length);
    };
    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "init") setEntries(msg.logs.map(toEntry).slice(-CONSOLE_LOG_CONFIG.maxLines));
      else if (msg.type === "line") append([toEntry(msg.line, 0)]);
      else if (msg.type === "lines") append(msg.lines.map(toEntry));
      else if (msg.type === "clear") { setEntries([]); setUnseen(0); }
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  const matcher = useMemo(() => buildMatcher(query), [query]);
  const visible = useMemo(() => {
    const levels = new Set(prefs.levels);
    return entries.filter((e) => levels.has(levelOf(e)) && matcher.test(e.text));
  }, [entries, prefs.levels, matcher]);

  // Tail: stay at the bottom while following.
  useEffect(() => {
    if (following && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [visible, following]);

  const setFollow = useCallback((on) => {
    followingRef.current = on;
    setFollowing(on);
    if (on) setUnseen(0);
  }, []);

  // Scrolling up pauses the tail; reaching the bottom resumes it.
  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== followingRef.current) setFollow(atBottom);
  };

  const shownText = () => visible.map((e) => `${prefs.timestamps && e.t ? `${formatTime(e.t)} ` : ""}${e.text}`).join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shownText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([shownText()], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `red-router-console-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clear = () => fetch("/api/translator/console-logs", { method: "DELETE" }).catch(() => {});

  const toggleLevel = (id) => {
    const levels = prefs.levels.includes(id) ? prefs.levels.filter((l) => l !== id) : [...prefs.levels, id];
    updatePrefs({ levels });
  };

  const counts = useMemo(() => {
    const c = { info: 0, warn: 0, error: 0, debug: 0 };
    for (const e of entries) c[levelOf(e)] += 1;
    return c;
  }, [entries]);

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={() => setFollow(!following)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
            following ? "bg-feedback-success-surface text-feedback-success-foreground" : "bg-surface-2 text-text-muted hover:text-text-main",
          )}
          title={following ? "Following new lines. Scroll up or click to pause." : "Paused. Click to follow new lines."}
        >
          <span className={cn("size-2 rounded-full", following && connected ? "animate-pulse bg-current" : "bg-current opacity-60")} />
          {following ? "Live" : "Paused"}
        </button>

        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter: text or /regex/"
          icon="search"
          className="w-full min-w-[12rem] flex-1 sm:w-auto"
          inputClassName="font-mono text-xs"
          error={matcher.error ? `Invalid regex: ${matcher.error}` : undefined}
        />

        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Levels">
          {LEVELS.map((l) => {
            const on = prefs.levels.includes(l.id);
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => toggleLevel(l.id)}
                aria-pressed={on}
                className={cn(
                  "inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs transition-colors",
                  on ? "border-border bg-surface-2 text-text-main" : "border-transparent text-text-muted line-through opacity-60",
                )}
              >
                <span className={l.tone}>{l.label}</span>
                <span className="tabular-nums text-text-muted">{counts[l.id]}</span>
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant={prefs.timestamps ? "secondary" : "ghost"} icon="schedule" onClick={() => updatePrefs({ timestamps: !prefs.timestamps })} aria-pressed={prefs.timestamps} title="Timestamps">
            Time
          </Button>
          <Button size="sm" variant={prefs.wrap ? "secondary" : "ghost"} icon="wrap_text" onClick={() => updatePrefs({ wrap: !prefs.wrap })} aria-pressed={prefs.wrap} title="Wrap long lines">
            Wrap
          </Button>
          <Button size="sm" variant="ghost" icon={copied ? "check" : "content_copy"} onClick={copy} aria-label="Copy shown lines" />
          <Button size="sm" variant="ghost" icon="download" onClick={download} aria-label="Download shown lines" />
          <Button size="sm" variant="ghost" icon="delete" onClick={clear} aria-label="Clear the console" />
        </div>
      </div>

      <div className="relative">
        <div
          ref={logRef}
          onScroll={onScroll}
          className="h-[calc(100vh-17rem)] min-h-[20rem] overflow-auto bg-bg-subtle px-3 py-2 font-mono text-xs leading-5"
          role="log"
          aria-live="off"
        >
          {visible.length === 0 ? (
            <p className="py-6 text-center text-text-muted">
              {entries.length === 0 ? "No console output yet." : "No line matches the filter."}
            </p>
          ) : (
            visible.map((e) => {
              const level = levelOf(e);
              const text = prefs.timestamps && e.t ? e.text.replace(CLOCK_PREFIX, "") : e.text;
              return (
                <div
                  key={e.id}
                  className={cn(
                    "flex gap-3 rounded-sm px-1 hover:bg-surface-2",
                    level === "error" && "bg-feedback-danger-surface/40",
                    level === "warn" && "bg-feedback-warning-surface/30",
                  )}
                >
                  {prefs.timestamps && <span className="shrink-0 select-none tabular-nums text-text-muted">{formatTime(e.t)}</span>}
                  <span className={cn("min-w-0", TONE[level], prefs.wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")}>
                    <Highlighted text={text} regex={matcher.regex} />
                  </span>
                </div>
              );
            })
          )}
        </div>
        {!following && (
          <button
            type="button"
            onClick={() => setFollow(true)}
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-white shadow-md"
          >
            <Icon name="arrow_downward" size={14} />
            {unseen > 0 ? `${unseen} new` : "Jump to latest"}
          </button>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[11px] text-text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", connected ? "bg-feedback-success-foreground" : "bg-feedback-danger-foreground")} />
          {connected ? "Connected" : "Reconnecting…"}
        </span>
        <span className="tabular-nums">{visible.length.toLocaleString()} of {entries.length.toLocaleString()} lines · keeps the last {CONSOLE_LOG_CONFIG.maxLines.toLocaleString()}</span>
      </div>
    </Card>
  );
}
