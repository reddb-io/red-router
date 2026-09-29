// src/app/(dashboard)/dashboard/playground/hooks/useChatSessions.ts
"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  STORAGE_KEYS,
  clearSession,
  createSession,
  deleteSession,
  getActiveId,
  loadSessions,
  renameSession,
  replaceMessages,
  resolveActiveId,
  saveSessions,
  setActiveId,
  sortSessions,
  type ChatMessage,
  type ChatSession,
  type StorageLike,
} from "../chatSessions";

/**
 * Persistent multi-session chat state for the Playground.
 *
 * The state lives in one module-level external store (read through `useSyncExternalStore`), so
 * every mutation is synchronous and functional updaters always see the latest messages — even
 * mid-stream. Writes to localStorage are debounced (streaming appends a delta per chunk) and are
 * flushed when the tab is hidden or the last subscriber leaves. localStorage may be unavailable
 * (privacy mode, blocked storage): the store then simply behaves as in-memory state.
 */

interface Snapshot {
  sessions: ChatSession[];
  activeId: string | null;
}

const EMPTY_SNAPSHOT: Snapshot = { sessions: [], activeId: null };
const PERSIST_DEBOUNCE_MS = 400;

let snapshot: Snapshot | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let listenersAttached = false;
const listeners = new Set<() => void>();

function getStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readFromStorage(): Snapshot {
  const storage = getStorage();
  const sessions = sortSessions(loadSessions(storage));
  return { sessions, activeId: getActiveId(storage, sessions) };
}

function getSnapshot(): Snapshot {
  if (snapshot === null) snapshot = readFromStorage();
  return snapshot;
}

function getServerSnapshot(): Snapshot {
  return EMPTY_SNAPSHOT;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function flush(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (snapshot === null) return;
  const storage = getStorage();
  if (!storage) return;
  const result = saveSessions(storage, snapshot.sessions);
  // Caps / quota eviction may have dropped sessions: keep memory in step with what is stored.
  if (result.sessions.length !== snapshot.sessions.length) {
    snapshot = {
      sessions: result.sessions,
      activeId: resolveActiveId(result.sessions, snapshot.activeId),
    };
    setActiveId(storage, snapshot.activeId);
    emit();
  }
}

function schedulePersist(): void {
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(flush, PERSIST_DEBOUNCE_MS);
}

function commit(next: Snapshot): void {
  const activeChanged = getSnapshot().activeId !== next.activeId;
  snapshot = next;
  if (activeChanged) setActiveId(getStorage(), next.activeId);
  schedulePersist();
  emit();
}

function onVisibility(): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") flush();
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEYS.sessions && event.key !== STORAGE_KEYS.activeId) return;
  // Local edits still waiting for their debounce win; the next flush overwrites the other tab.
  if (persistTimer !== null) return;
  snapshot = readFromStorage();
  emit();
}

function attachListeners(): void {
  if (listenersAttached || typeof window === "undefined") return;
  listenersAttached = true;
  window.addEventListener("pagehide", flush);
  window.addEventListener("storage", onStorage);
  document.addEventListener("visibilitychange", onVisibility);
}

function detachListeners(): void {
  if (!listenersAttached || typeof window === "undefined") return;
  listenersAttached = false;
  window.removeEventListener("pagehide", flush);
  window.removeEventListener("storage", onStorage);
  document.removeEventListener("visibilitychange", onVisibility);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  attachListeners();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      flush();
      detachListeners();
    }
  };
}

// --- store actions (module level: stable identities, always operate on the latest state) ------

function selectSession(id: string): void {
  const current = getSnapshot();
  if (!current.sessions.some((s) => s.id === id) || current.activeId === id) return;
  commit({ ...current, activeId: id });
}

function newChat(): string {
  const current = getSnapshot();
  // Reuse the active session when it is still empty instead of piling up blank chats.
  const active = current.sessions.find((s) => s.id === current.activeId);
  if (active && active.messages.length === 0) return active.id;
  const created = createSession(current.sessions);
  commit({ sessions: created.sessions, activeId: created.session.id });
  return created.session.id;
}

function rename(id: string, title: string): void {
  const current = getSnapshot();
  commit({ ...current, sessions: sortSessions(renameSession(current.sessions, id, title)) });
}

function remove(id: string): void {
  const current = getSnapshot();
  const sessions = deleteSession(current.sessions, id);
  commit({ sessions, activeId: resolveActiveId(sessions, current.activeId) });
}

function clear(id: string): void {
  const current = getSnapshot();
  commit({ ...current, sessions: sortSessions(clearSession(current.sessions, id)) });
}

function setActiveMessages<M extends ChatMessage>(updater: M[] | ((prev: M[]) => M[])): void {
  let current = getSnapshot();
  let id = current.activeId;
  if (!id || !current.sessions.some((s) => s.id === id)) {
    const created = createSession(current.sessions);
    current = { sessions: created.sessions, activeId: created.session.id };
    id = created.session.id;
  }
  const session = current.sessions.find((s) => s.id === id);
  const prev = (session?.messages ?? []) as M[];
  const next = typeof updater === "function" ? updater(prev) : updater;
  commit({
    activeId: id,
    sessions: sortSessions(replaceMessages(current.sessions, id, next)),
  });
}

export interface UseChatSessions<M extends ChatMessage> {
  /** Newest first. */
  sessions: ChatSession<M>[];
  activeId: string | null;
  /** Messages of the active session (empty when there is none yet). */
  messages: M[];
  /** Same contract as a React state setter; creates a session on first write. */
  setMessages: (updater: M[] | ((prev: M[]) => M[])) => void;
  selectSession: (id: string) => void;
  newChat: () => string;
  renameSession: (id: string, title: string) => void;
  deleteSession: (id: string) => void;
  clearSession: (id: string) => void;
}

const NO_MESSAGES: never[] = [];

export function useChatSessions<M extends ChatMessage = ChatMessage>(): UseChatSessions<M> {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const active = state.sessions.find((s) => s.id === state.activeId);
  const setMessages = useCallback(
    (updater: M[] | ((prev: M[]) => M[])) => setActiveMessages<M>(updater),
    []
  );
  return {
    sessions: state.sessions as ChatSession<M>[],
    activeId: state.activeId,
    messages: (active?.messages ?? NO_MESSAGES) as M[],
    setMessages,
    selectSession,
    newChat,
    renameSession: rename,
    deleteSession: remove,
    clearSession: clear,
  };
}
