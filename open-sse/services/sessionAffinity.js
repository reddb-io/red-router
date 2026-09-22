// Per-session combo member stickiness. Once a member served a session, that
// session's next request tries it first: a model switch mid-session rewrites the
// upstream prompt cache, which costs more than the rotation it would honour.
//
// A preference, never a restriction: the member only moves to the front of the
// list, so a failure still falls through to the rest of the combo. The entry is
// dropped when the member fails, and expires after SESSION_AFFINITY_CONFIG.ttlMs
// idle. In-process and LRU-bounded, like the combo rotation state.

import { SESSION_AFFINITY_CONFIG } from "../config/runtimeConfig.js";

/** Key = `${comboName}\u0000${sessionKey}`, value = { model, lastUsed }. Map order is recency. */
const affinity = new Map();

const keyOf = (comboName, sessionKey) => `${comboName || "__default__"}\u0000${sessionKey}`;

/** The member that last served this session on this combo, or null. */
export function getSessionMember(comboName, sessionKey, now = Date.now()) {
  if (!sessionKey) return null;
  const key = keyOf(comboName, sessionKey);
  const entry = affinity.get(key);
  if (!entry) return null;
  if (now - entry.lastUsed > SESSION_AFFINITY_CONFIG.ttlMs) {
    affinity.delete(key);
    return null;
  }
  return entry.model;
}

/** Record the member that just served this session. */
export function rememberSessionMember(comboName, sessionKey, model, now = Date.now()) {
  if (!sessionKey || !model) return;
  const key = keyOf(comboName, sessionKey);
  affinity.delete(key);
  if (affinity.size >= SESSION_AFFINITY_CONFIG.maxEntries) {
    affinity.delete(affinity.keys().next().value);
  }
  affinity.set(key, { model, lastUsed: now });
}

/** Drop the preference, e.g. because the member failed. */
export function forgetSessionMember(comboName, sessionKey, model = null) {
  if (!sessionKey) return;
  const key = keyOf(comboName, sessionKey);
  if (model && affinity.get(key)?.model !== model) return;
  affinity.delete(key);
}

/**
 * The combo order for a session: its remembered member first, the rest in the
 * given order. Unchanged when there is no member or it left the combo.
 */
export function preferSessionMember(models, member) {
  if (!member || !Array.isArray(models)) return models;
  const index = models.indexOf(member);
  if (index <= 0) return models;
  return [member, ...models.filter((_, i) => i !== index)];
}

export function resetSessionAffinity() {
  affinity.clear();
}

export function sessionAffinitySize() {
  return affinity.size;
}
