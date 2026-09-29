import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_LIMITS,
  DEFAULT_TITLE,
  IMAGE_REMOVED_PLACEHOLDER,
  STORAGE_KEYS,
  appendMessage,
  clearSession,
  createSession,
  deleteSession,
  deriveTitle,
  enforceLimits,
  getActiveId,
  loadSessions,
  renameSession,
  replaceMessages,
  resolveActiveId,
  saveSessions,
  setActiveId,
  sortSessions,
  stripImageData,
  type ChatMessage,
  type ChatSession,
  type StorageLike,
} from "../../../src/app/(dashboard)/dashboard/playground/chatSessions.ts";

const root = process.cwd();
const PLAYGROUND = "src/app/(dashboard)/dashboard/playground";

function memoryStorage(seed: Record<string, string> = {}): StorageLike & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>(Object.entries(seed));
  return {
    data,
    getItem: (key) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function session(id: string, updatedAt: number, messages: ChatMessage[] = []): ChatSession {
  return { id, title: id, titleLocked: false, createdAt: updatedAt, updatedAt, messages };
}

const user = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  role: "user",
  content,
  ...extra,
});
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });

const IMAGE = `data:image/png;base64,${"A".repeat(400)}`;

test("storage keys live in the redrouter.playground.chat namespace", () => {
  assert.equal(STORAGE_KEYS.sessions, "redrouter.playground.chat.sessions");
  assert.equal(STORAGE_KEYS.activeId, "redrouter.playground.chat.activeId");
});

test("deriveTitle trims, collapses whitespace, caps length and falls back", () => {
  assert.equal(deriveTitle("  hello \n\t  world  "), "hello world");
  assert.equal(deriveTitle(""), DEFAULT_TITLE);
  assert.equal(deriveTitle("   \n "), DEFAULT_TITLE);
  assert.equal(deriveTitle(undefined), DEFAULT_TITLE);
  assert.equal(deriveTitle(42), DEFAULT_TITLE);
  const long = deriveTitle("x".repeat(200));
  assert.equal(long.length, 48);
  assert.ok(long.endsWith("…"));
  assert.equal(deriveTitle("y".repeat(48)), "y".repeat(48));
});

test("createSession prepends a fresh empty session with the default title", () => {
  const first = createSession([], { id: "a", now: 100 });
  assert.equal(first.session.title, DEFAULT_TITLE);
  assert.deepEqual(first.session.messages, []);
  assert.equal(first.session.titleLocked, false);
  const second = createSession(first.sessions, { id: "b", now: 200 });
  assert.deepEqual(
    second.sessions.map((s) => s.id),
    ["b", "a"]
  );
  const generated = createSession([]);
  assert.ok(generated.session.id.length > 0);
  assert.notEqual(createSession([]).session.id, generated.session.id);
});

test("sortSessions orders by updatedAt descending without mutating its input", () => {
  const input = [session("a", 1), session("c", 3), session("b", 2)];
  assert.deepEqual(
    sortSessions(input).map((s) => s.id),
    ["c", "b", "a"]
  );
  assert.deepEqual(
    input.map((s) => s.id),
    ["a", "c", "b"]
  );
});

test("replaceMessages derives the title from the first user message and bumps updatedAt", () => {
  const base = createSession([], { id: "a", now: 1 }).sessions;
  const next = replaceMessages(base, "a", [assistant("hi"), user("  Explain   routing \n")], 50);
  assert.equal(next[0].title, "Explain routing");
  assert.equal(next[0].updatedAt, 50);
  assert.equal(base[0].messages.length, 0, "input is not mutated");
  // unknown ids are a no-op
  assert.equal(replaceMessages(base, "zzz", [], 60), base);
});

test("appendMessage adds to the end of the session", () => {
  let list = createSession([], { id: "a", now: 1 }).sessions;
  list = appendMessage(list, "a", user("first"), 2);
  list = appendMessage(list, "a", assistant("reply"), 3);
  assert.deepEqual(
    list[0].messages.map((m) => m.content),
    ["first", "reply"]
  );
  assert.equal(list[0].title, "first");
  assert.equal(list[0].updatedAt, 3);
});

test("renameSession locks the title; a blank name unlocks and re-derives it", () => {
  let list = createSession([], { id: "a", now: 1 }).sessions;
  list = renameSession(list, "a", "  My   chat ", 2);
  assert.equal(list[0].title, "My chat");
  assert.equal(list[0].titleLocked, true);
  list = replaceMessages(list, "a", [user("something else")], 3);
  assert.equal(list[0].title, "My chat", "a locked title does not follow the first message");
  list = renameSession(list, "a", "   ", 4);
  assert.equal(list[0].titleLocked, false);
  assert.equal(list[0].title, "something else");
  assert.equal(renameSession(list, "a", "x".repeat(200))[0].title.length, 48);
});

test("clearSession empties messages and resets an auto title but keeps a locked one", () => {
  let list = replaceMessages(createSession([], { id: "a", now: 1 }).sessions, "a", [user("q")], 2);
  assert.equal(list[0].title, "q");
  list = clearSession(list, "a", 3);
  assert.deepEqual(list[0].messages, []);
  assert.equal(list[0].title, DEFAULT_TITLE);
  list = renameSession(replaceMessages(list, "a", [user("q")], 4), "a", "Pinned", 5);
  list = clearSession(list, "a", 6);
  assert.equal(list[0].title, "Pinned");
  assert.deepEqual(list[0].messages, []);
});

test("deleteSession removes only the target session", () => {
  const list = [session("a", 3), session("b", 2), session("c", 1)];
  assert.deepEqual(
    deleteSession(list, "b").map((s) => s.id),
    ["a", "c"]
  );
  assert.equal(deleteSession(list, "missing").length, 3);
});

test("active id: persisted, stale ids fall back to the newest session, deletion re-resolves", () => {
  const storage = memoryStorage();
  const list = [session("old", 1), session("new", 9), session("mid", 5)];
  assert.equal(getActiveId(storage, list), "new", "no stored id -> newest");
  assert.equal(setActiveId(storage, "mid"), true);
  assert.equal(getActiveId(storage, list), "mid");
  assert.equal(getActiveId(storage, [session("old", 1)]), "old", "stored id no longer exists");
  assert.equal(getActiveId(storage, []), null);
  assert.equal(setActiveId(storage, null), true);
  assert.equal(storage.data.has(STORAGE_KEYS.activeId), false);

  // After deleting the active session the next active id is the newest remaining one.
  const remaining = deleteSession(list, "new");
  assert.equal(resolveActiveId(remaining, "new"), "mid");
  assert.equal(resolveActiveId(deleteSession(remaining, "mid"), "mid"), "old");
  assert.equal(resolveActiveId([], "old"), null);
});

test("active id helpers never throw when storage throws", () => {
  const broken: StorageLike = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(getActiveId(broken, [session("a", 1)]), "a");
  assert.equal(setActiveId(broken, "a"), false);
  assert.equal(setActiveId(broken, null), false);
  assert.equal(getActiveId(null, [session("a", 1)]), "a");
  assert.equal(setActiveId(null, "a"), false);
});

test("save then load round-trips sessions, newest first", () => {
  const storage = memoryStorage();
  const list = [
    session("a", 1, [user("one")]),
    session("b", 2, [user("two", { metrics: { tokensIn: 3 } })]),
  ];
  const saved = saveSessions(storage, list);
  assert.equal(saved.ok, true);
  const loaded = loadSessions(storage);
  assert.deepEqual(
    loaded.map((s) => s.id),
    ["b", "a"]
  );
  assert.deepEqual(loaded[0].messages[0].metrics, { tokensIn: 3 });
});

test("loadSessions tolerates corrupt JSON, wrong shapes and a throwing getItem", () => {
  assert.deepEqual(loadSessions(memoryStorage({ [STORAGE_KEYS.sessions]: "{not json" })), []);
  assert.deepEqual(loadSessions(memoryStorage({ [STORAGE_KEYS.sessions]: '{"a":1}' })), []);
  assert.deepEqual(loadSessions(memoryStorage({ [STORAGE_KEYS.sessions]: "null" })), []);
  assert.deepEqual(loadSessions(memoryStorage()), []);
  assert.deepEqual(loadSessions(null), []);
  assert.deepEqual(
    loadSessions({
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
      removeItem: () => {},
    }),
    []
  );

  const mixed = JSON.stringify([
    null,
    "junk",
    { id: "" },
    {
      id: "dup",
      messages: [{ role: "user", content: "kept" }, { role: "bogus", content: "x" }, 7],
    },
    { id: "dup", messages: [] },
    { id: "ok", title: "  Named  ", titleLocked: true, updatedAt: "nope", messages: "nope" },
  ]);
  const loaded = loadSessions(memoryStorage({ [STORAGE_KEYS.sessions]: mixed }));
  assert.deepEqual(loaded.map((s) => s.id).sort(), ["dup", "ok"]);
  const dup = loaded.find((s) => s.id === "dup");
  assert.deepEqual(dup?.messages, [{ role: "user", content: "kept" }]);
  assert.equal(dup?.title, "kept");
  const ok = loaded.find((s) => s.id === "ok");
  assert.equal(ok?.title, "Named");
  assert.deepEqual(ok?.messages, []);
  assert.ok(Number.isFinite(ok?.updatedAt));
});

test("saveSessions never throws when setItem always throws", () => {
  const broken: StorageLike = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  const result = saveSessions(broken, [session("a", 2), session("b", 1)]);
  assert.equal(result.ok, false);
  assert.ok(result.sessions.length >= 1, "the in-memory copy is still returned");
  assert.equal(saveSessions(null, [session("a", 1)]).ok, false);
});

test("saveSessions evicts the oldest session and retries on a quota error", () => {
  const data = new Map<string, string>();
  const quota: StorageLike = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      if (v.length > 900) throw new Error("QuotaExceededError");
      data.set(k, v);
    },
    removeItem: (k) => void data.delete(k),
  };
  const body = "z".repeat(300);
  const list = [
    session("newest", 4, [user(body)]),
    session("newer", 3, [user(body)]),
    session("older", 2, [user(body)]),
    session("oldest", 1, [user(body)]),
  ];
  const result = saveSessions(quota, list);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.sessions.map((s) => s.id),
    ["newest", "newer"]
  );
  assert.deepEqual(
    loadSessions(quota).map((s) => s.id),
    ["newest", "newer"]
  );
});

test("hard caps: at most 50 sessions and 200 messages per session", () => {
  assert.equal(DEFAULT_LIMITS.maxSessions, 50);
  assert.equal(DEFAULT_LIMITS.maxMessagesPerSession, 200);
  assert.equal(DEFAULT_LIMITS.maxBytes, 2_000_000);

  const many = Array.from({ length: 60 }, (_, i) => session(`s${i}`, i));
  const kept = enforceLimits(many);
  assert.equal(kept.length, 50);
  assert.equal(kept[0].id, "s59");
  assert.equal(kept[49].id, "s10", "the 10 oldest are the ones dropped");

  const long = session(
    "long",
    1,
    Array.from({ length: 250 }, (_, i) => user(`m${i}`))
  );
  const [trimmed] = enforceLimits([long]);
  assert.equal(trimmed.messages.length, 200);
  assert.equal(trimmed.messages[0].content, "m50", "the oldest messages are dropped");
  assert.equal(trimmed.messages[199].content, "m249");
});

test("size budget: image data is stripped oldest-first before any session is dropped", () => {
  const withImage = (id: string, updatedAt: number): ChatSession =>
    session(id, updatedAt, [user(`see ${id}`, { images: [IMAGE] }), assistant(`ok ${id}`)]);
  const list = [withImage("new", 3), withImage("mid", 2), withImage("old", 1)];
  const full = JSON.stringify(list).length;
  // Slightly under the full size: stripping the oldest session's image is enough to fit.
  const result = enforceLimits(list, {
    ...DEFAULT_LIMITS,
    maxBytes: full - 100,
  });
  assert.deepEqual(
    result.map((s) => s.id),
    ["new", "mid", "old"],
    "no session was dropped"
  );
  const byId = Object.fromEntries(result.map((s) => [s.id, s]));
  assert.equal(byId.old.messages[0].images, undefined, "oldest lost its image");
  assert.ok(byId.mid.messages[0].images, "newer sessions keep theirs");
  assert.ok(byId.new.messages[0].images);
  assert.equal(byId.old.messages[0].content, `see old`);
});

test("size budget: once every image is stripped, the oldest sessions are dropped first", () => {
  const body = "q".repeat(500);
  const list = [
    session("s4", 4, [user(body)]),
    session("s3", 3, [user(body)]),
    session("s2", 2, [user(body)]),
    session("s1", 1, [user(body)]),
  ];
  const oneSize = JSON.stringify([list[0]]).length;
  const result = enforceLimits(list, { ...DEFAULT_LIMITS, maxBytes: oneSize * 2 + 10 });
  assert.deepEqual(
    result.map((s) => s.id),
    ["s4", "s3"]
  );
});

test("size budget: a single oversized session keeps its newest messages, never zero sessions", () => {
  const big = session(
    "only",
    1,
    Array.from({ length: 40 }, (_, i) => user(`${i}:${"w".repeat(200)}`))
  );
  const result = enforceLimits([big], { ...DEFAULT_LIMITS, maxBytes: 3000 });
  assert.equal(result.length, 1);
  assert.ok(JSON.stringify(result).length <= 3000);
  const contents = result[0].messages.map((m) => m.content);
  assert.ok(contents.length >= 1 && contents.length < 40);
  assert.ok(contents[contents.length - 1].startsWith("39:"), "the newest message survives");
});

test("stripImageData removes data URLs from content and the images array only", () => {
  const stripped = stripImageData(user(`look ${IMAGE} here`, { images: [IMAGE] }));
  assert.equal(stripped.content, `look ${IMAGE_REMOVED_PLACEHOLDER} here`);
  assert.equal(stripped.images, undefined);
  const plain = user("no images, see https://example.com/a.png");
  assert.equal(stripImageData(plain), plain, "untouched messages keep their identity");
  const remote = stripImageData(user("x", { images: [] }));
  assert.equal(remote.content, "x");
});

test("saveSessions applies the caps before writing", () => {
  const storage = memoryStorage();
  const many = Array.from({ length: 55 }, (_, i) => session(`s${i}`, i));
  const result = saveSessions(storage, many);
  assert.equal(result.ok, true);
  assert.equal(result.sessions.length, 50);
  assert.equal(JSON.parse(storage.data.get(STORAGE_KEYS.sessions) as string).length, 50);
});

test("ChatTab persists through useChatSessions and uses no Material Symbols", () => {
  const chatTab = fs.readFileSync(
    path.join(root, PLAYGROUND, "components/tabs/ChatTab.tsx"),
    "utf8"
  );
  assert.match(chatTab, /from "\.\.\/\.\.\/hooks\/useChatSessions"/);
  assert.match(chatTab, /useChatSessions</);
  assert.match(chatTab, /ConfirmModal/);
  assert.doesNotMatch(chatTab, /material-symbols-outlined/);

  const sidebar = fs.readFileSync(
    path.join(root, PLAYGROUND, "components/tabs/ChatSessionSidebar.tsx"),
    "utf8"
  );
  assert.doesNotMatch(sidebar, /material-symbols-outlined/);

  const hook = fs.readFileSync(path.join(root, PLAYGROUND, "hooks/useChatSessions.ts"), "utf8");
  assert.match(hook, /useSyncExternalStore/);
  assert.match(hook, /from "\.\.\/chatSessions"/);

  const pure = fs.readFileSync(path.join(root, PLAYGROUND, "chatSessions.ts"), "utf8");
  assert.doesNotMatch(pure, /^import /m, "the module has no imports (no React)");
  assert.doesNotMatch(pure, /\bwindow\.|\bdocument\.|\blocalStorage\./, "no browser globals");
});
