// src/app/(dashboard)/dashboard/playground/chatSessions.ts
//
// Pure persistence + session-list logic for the Playground chat. No React, no `window`: every
// storage-touching function takes an injected `StorageLike`, and every mutator is a pure function
// over a session array that returns a new array. Ported in spirit from 9router's
// `dashboard/basic-chat` (sessions sorted by updatedAt, titles derived from the first message,
// create / rename / delete / clear), with hard caps so localStorage can never grow without bound.

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  metrics?: Record<string, unknown>;
  /** Attached images as base64 data URLs. Stripped first when storage is over budget. */
  images?: string[];
}

export interface ChatSession<M extends ChatMessage = ChatMessage> {
  id: string;
  title: string;
  /** True once the user renamed the session: the title then stops following the first message. */
  titleLocked: boolean;
  createdAt: number;
  updatedAt: number;
  messages: M[];
}

export interface ChatSessionLimits {
  maxSessions: number;
  maxMessagesPerSession: number;
  /** Maximum serialized size, in UTF-16 code units of the JSON string. */
  maxBytes: number;
}

export const STORAGE_KEYS = {
  sessions: "redrouter.playground.chat.sessions",
  activeId: "redrouter.playground.chat.activeId",
} as const;

export const DEFAULT_LIMITS: ChatSessionLimits = {
  maxSessions: 50,
  maxMessagesPerSession: 200,
  maxBytes: 2_000_000,
};

export const DEFAULT_TITLE = "New chat";
export const MAX_TITLE_LENGTH = 48;
export const IMAGE_REMOVED_PLACEHOLDER = "[image removed]";

const DATA_IMAGE_URL = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;
const VALID_ROLES: readonly string[] = ["system", "user", "assistant"];

let idCounter = 0;

function generateId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  idCounter += 1;
  return `chat_${Date.now().toString(36)}_${idCounter}_${Math.random().toString(16).slice(2, 8)}`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function capTitle(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Trim, collapse whitespace, cap at ~48 chars; "New chat" when there is nothing to show. */
export function deriveTitle(firstUserMessage: unknown): string {
  const text = typeof firstUserMessage === "string" ? collapse(firstUserMessage) : "";
  if (!text) return DEFAULT_TITLE;
  return capTitle(text, MAX_TITLE_LENGTH);
}

function titleFromMessages(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user" && collapse(m.content).length > 0);
  return deriveTitle(first?.content);
}

/** Newest first; ties keep a stable order by id so the list never flickers. */
export function sortSessions<S extends { id: string; updatedAt: number }>(sessions: S[]): S[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------------------------
// Validation of untrusted (stored) data
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeMessage(raw: unknown): ChatMessage | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.role !== "string" || !VALID_ROLES.includes(raw.role)) return null;
  if (typeof raw.content !== "string") return null;
  const message: ChatMessage = { role: raw.role as ChatRole, content: raw.content };
  if (isRecord(raw.metrics)) message.metrics = raw.metrics;
  if (Array.isArray(raw.images)) {
    const images = raw.images.filter((i): i is string => typeof i === "string");
    if (images.length > 0) message.images = images;
  }
  return message;
}

function sanitizeSession(raw: unknown): ChatSession | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map(sanitizeMessage).filter((m): m is ChatMessage => m !== null)
    : [];
  const now = Date.now();
  const createdAt = Number.isFinite(raw.createdAt) ? (raw.createdAt as number) : now;
  const updatedAt = Number.isFinite(raw.updatedAt) ? (raw.updatedAt as number) : createdAt;
  const titleLocked = raw.titleLocked === true;
  const storedTitle = typeof raw.title === "string" ? collapse(raw.title) : "";
  const title = storedTitle ? capTitle(storedTitle, MAX_TITLE_LENGTH) : titleFromMessages(messages);
  return { id: raw.id, title, titleLocked, createdAt, updatedAt, messages };
}

// ---------------------------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------------------------

/** Replace base64 image data URLs (in content and in `images`) so the message stays readable. */
export function stripImageData<M extends ChatMessage>(message: M): M {
  const hasImages = Array.isArray(message.images) && message.images.length > 0;
  DATA_IMAGE_URL.lastIndex = 0;
  const hasInline = DATA_IMAGE_URL.test(message.content);
  DATA_IMAGE_URL.lastIndex = 0;
  if (!hasImages && !hasInline) return message;
  const next = {
    ...message,
    content: message.content.replace(DATA_IMAGE_URL, IMAGE_REMOVED_PLACEHOLDER),
  };
  delete next.images;
  return next;
}

function stripSession<M extends ChatMessage>(session: ChatSession<M>): ChatSession<M> {
  let changed = false;
  const messages = session.messages.map((m) => {
    const stripped = stripImageData(m);
    if (stripped !== m) changed = true;
    return stripped;
  });
  return changed ? { ...session, messages } : session;
}

function serializedSize(sessions: ChatSession[]): number {
  return JSON.stringify(sessions).length;
}

/**
 * Apply the hard caps and return the sessions to persist (newest first).
 *
 * 1. at most `maxSessions` sessions (oldest dropped) and `maxMessagesPerSession` messages each
 *    (oldest messages dropped);
 * 2. when the serialized size is still over `maxBytes`: strip base64 image data from the OLDEST
 *    sessions first, one session at a time;
 * 3. still over: drop the OLDEST sessions one by one, never the newest;
 * 4. still over (one giant session): drop its oldest messages, keeping at least the last one.
 */
export function enforceLimits<M extends ChatMessage>(
  sessions: ChatSession<M>[],
  limits: ChatSessionLimits = DEFAULT_LIMITS
): ChatSession<M>[] {
  let list = sortSessions(sessions)
    .slice(0, Math.max(1, limits.maxSessions))
    .map((s) =>
      s.messages.length > limits.maxMessagesPerSession
        ? { ...s, messages: s.messages.slice(-limits.maxMessagesPerSession) }
        : s
    );
  if (serializedSize(list) <= limits.maxBytes) return list;

  for (let i = list.length - 1; i >= 0; i--) {
    const stripped = stripSession(list[i]);
    if (stripped !== list[i]) {
      list = [...list.slice(0, i), stripped, ...list.slice(i + 1)];
      if (serializedSize(list) <= limits.maxBytes) return list;
    }
  }

  while (list.length > 1 && serializedSize(list) > limits.maxBytes) {
    list = list.slice(0, -1);
  }

  const newest = list[0];
  if (newest && serializedSize(list) > limits.maxBytes) {
    let messages = newest.messages;
    while (messages.length > 1 && serializedSize([{ ...newest, messages }]) > limits.maxBytes) {
      messages = messages.slice(Math.ceil(messages.length / 4) || 1);
    }
    list = [{ ...newest, messages }];
  }
  return list;
}

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

/** Read + validate sessions. Corrupt JSON, wrong shapes and throwing storage all yield `[]`. */
export function loadSessions(storage: StorageLike | null | undefined): ChatSession[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEYS.sessions);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const sessions: ChatSession[] = [];
    for (const entry of parsed) {
      const session = sanitizeSession(entry);
      if (!session || seen.has(session.id)) continue;
      seen.add(session.id);
      sessions.push(session);
    }
    return enforceLimits(sessions);
  } catch {
    return [];
  }
}

export interface SaveResult<M extends ChatMessage = ChatMessage> {
  ok: boolean;
  /** What actually reached (or would have reached) storage after caps and quota eviction. */
  sessions: ChatSession<M>[];
}

/**
 * Persist sessions after applying the caps. Never throws: on a quota / storage error the oldest
 * session is evicted and the write retried; if nothing fits, `ok` is false and the caller keeps
 * its in-memory copy.
 */
export function saveSessions<M extends ChatMessage>(
  storage: StorageLike | null | undefined,
  sessions: ChatSession<M>[],
  limits: ChatSessionLimits = DEFAULT_LIMITS
): SaveResult<M> {
  let toWrite = enforceLimits(sessions, limits);
  if (!storage) return { ok: false, sessions: toWrite };
  for (;;) {
    try {
      storage.setItem(STORAGE_KEYS.sessions, JSON.stringify(toWrite));
      return { ok: true, sessions: toWrite };
    } catch {
      if (toWrite.length <= 1) {
        // Last resort: drop the persisted copy so a stale, larger one does not linger.
        try {
          storage.removeItem(STORAGE_KEYS.sessions);
        } catch {
          // storage is unusable; nothing else to do
        }
        return { ok: false, sessions: toWrite };
      }
      toWrite = toWrite.slice(0, -1);
    }
  }
}

/** The active session id, falling back to the newest session when the stored id is stale. */
export function getActiveId(
  storage: StorageLike | null | undefined,
  sessions: ChatSession[]
): string | null {
  let stored: string | null = null;
  try {
    stored = storage ? storage.getItem(STORAGE_KEYS.activeId) : null;
  } catch {
    stored = null;
  }
  return resolveActiveId(sessions, stored);
}

export function setActiveId(storage: StorageLike | null | undefined, id: string | null): boolean {
  if (!storage) return false;
  try {
    if (id) storage.setItem(STORAGE_KEYS.activeId, id);
    else storage.removeItem(STORAGE_KEYS.activeId);
    return true;
  } catch {
    return false;
  }
}

/** `preferred` when it names an existing session, otherwise the newest session, otherwise null. */
export function resolveActiveId(
  sessions: ChatSession[],
  preferred: string | null | undefined
): string | null {
  if (preferred && sessions.some((s) => s.id === preferred)) return preferred;
  return sortSessions(sessions)[0]?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Pure mutators
// ---------------------------------------------------------------------------------------------

export interface CreateSessionOptions {
  id?: string;
  title?: string;
  now?: number;
}

export function createSession<M extends ChatMessage>(
  sessions: ChatSession<M>[],
  options: CreateSessionOptions = {}
): { sessions: ChatSession<M>[]; session: ChatSession<M> } {
  const now = options.now ?? Date.now();
  const title = options.title ? deriveTitle(options.title) : DEFAULT_TITLE;
  const session: ChatSession<M> = {
    id: options.id ?? generateId(),
    title,
    titleLocked: false,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  return { sessions: sortSessions([session, ...sessions]), session };
}

function updateSession<M extends ChatMessage>(
  sessions: ChatSession<M>[],
  id: string,
  update: (session: ChatSession<M>) => ChatSession<M>
): ChatSession<M>[] {
  if (!sessions.some((s) => s.id === id)) return sessions;
  return sessions.map((s) => (s.id === id ? update(s) : s));
}

/** An empty (or whitespace-only) name unlocks the title and re-derives it from the messages. */
export function renameSession<M extends ChatMessage>(
  sessions: ChatSession<M>[],
  id: string,
  title: string,
  now: number = Date.now()
): ChatSession<M>[] {
  return updateSession(sessions, id, (s) => {
    const cleaned = collapse(title);
    if (!cleaned) {
      return { ...s, titleLocked: false, title: titleFromMessages(s.messages), updatedAt: now };
    }
    return { ...s, titleLocked: true, title: capTitle(cleaned, MAX_TITLE_LENGTH), updatedAt: now };
  });
}

export function deleteSession<M extends ChatMessage>(
  sessions: ChatSession<M>[],
  id: string
): ChatSession<M>[] {
  return sessions.filter((s) => s.id !== id);
}

/** Remove every message but keep the session (and a user-chosen title). */
export function clearSession<M extends ChatMessage>(
  sessions: ChatSession<M>[],
  id: string,
  now: number = Date.now()
): ChatSession<M>[] {
  return updateSession(sessions, id, (s) => ({
    ...s,
    messages: [],
    title: s.titleLocked ? s.title : DEFAULT_TITLE,
    updatedAt: now,
  }));
}

export function replaceMessages<M extends ChatMessage>(
  sessions: ChatSession<M>[],
  id: string,
  messages: M[],
  now: number = Date.now()
): ChatSession<M>[] {
  return updateSession(sessions, id, (s) => ({
    ...s,
    messages,
    title: s.titleLocked ? s.title : titleFromMessages(messages),
    updatedAt: now,
  }));
}

export function appendMessage<M extends ChatMessage>(
  sessions: ChatSession<M>[],
  id: string,
  message: M,
  now: number = Date.now()
): ChatSession<M>[] {
  const current = sessions.find((s) => s.id === id);
  if (!current) return sessions;
  return replaceMessages(sessions, id, [...current.messages, message], now);
}
