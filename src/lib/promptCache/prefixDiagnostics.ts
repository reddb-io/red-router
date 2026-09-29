/**
 * Prompt-cache prefix diagnostics (X-CACHE1).
 *
 * Providers cache by EXACT prefix: everything up to a breakpoint must be byte-identical between
 * two requests for the second one to read what the first one wrote. In an agent tool loop the
 * next request only appends messages, so the cache holds — unless something rewrote `tools`,
 * `system`, an earlier message, or the thinking parameters in between. This module fingerprints
 * the body that is actually sent upstream, compares it with the previous request of the same
 * conversation and names the first place (and the likely cause) where the prefix diverged. It is
 * pure and bounded; persistence and the dashboard live elsewhere.
 */

import { jsonSha256 } from "@omniroute/open-sse/utils/jsonHash.ts";

type JsonRecord = Record<string, unknown>;

export type PrefixCause =
  | "first_request"
  | "none"
  | "tools_changed"
  | "system_changed"
  | "thinking_changed"
  | "tool_choice_changed"
  | "history_mutated"
  | "history_truncated"
  | "account_changed";

export interface PrefixFingerprint {
  tools: string;
  system: string;
  toolChoice: string;
  /** The parameters that steer thinking; Anthropic invalidates cached messages when they change. */
  thinking: string;
  /** One digest per message/input item, in order. */
  messages: string[];
}

export interface PrefixObservation {
  conversationKey: string;
  /** 1 for the first request seen of this conversation. */
  requestIndex: number;
  messageCount: number;
  previousMessageCount: number;
  /** Messages at the start that are identical to the previous request's. */
  stablePrefixMessages: number;
  /** Index of the first message that differs, or -1 when the request only appended. */
  firstDivergentIndex: number;
  /** Highest-impact cause; `none` means a pure append (the cache should hold). */
  cause: PrefixCause;
  /** Every cause detected, most impactful first. */
  causes: PrefixCause[];
}

const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};

const digest = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  try {
    return jsonSha256(value).slice(0, 16);
  } catch {
    return "unhashable";
  }
};

/** The conversation items of any client/upstream format. */
export function messagesOf(body: JsonRecord): unknown[] {
  if (Array.isArray(body.messages)) return body.messages;
  if (Array.isArray(body.input)) return body.input;
  if (Array.isArray(body.contents)) return body.contents;
  const request = asRecord(body.request);
  if (Array.isArray(request.contents)) return request.contents;
  return [];
}

export function fingerprintBody(body: JsonRecord | null | undefined): PrefixFingerprint {
  const source = asRecord(body);
  const generation = asRecord(source.generationConfig);
  return {
    tools: digest(source.tools),
    system: digest(source.system ?? source.instructions ?? source.systemInstruction),
    toolChoice: digest(source.tool_choice ?? source.toolChoice),
    thinking: digest({
      thinking: source.thinking,
      output_config: source.output_config,
      reasoning: source.reasoning,
      reasoning_effort: source.reasoning_effort,
      effort: source.effort,
      thinkingConfig: generation.thinkingConfig ?? generation.thinking_config,
    }),
    messages: messagesOf(source).map((message) => digest(message)),
  };
}

const CAUSE_ORDER: PrefixCause[] = [
  "tools_changed",
  "system_changed",
  "thinking_changed",
  "tool_choice_changed",
  "history_mutated",
  "history_truncated",
  "account_changed",
];

/** How a request's prefix relates to the previous request of the same conversation. */
export function diffFingerprints(
  previous: PrefixFingerprint | null,
  next: PrefixFingerprint,
  options: { accountChanged?: boolean } = {}
): Omit<PrefixObservation, "conversationKey" | "requestIndex"> {
  if (!previous) {
    return {
      messageCount: next.messages.length,
      previousMessageCount: 0,
      stablePrefixMessages: 0,
      firstDivergentIndex: -1,
      cause: "first_request",
      causes: ["first_request"],
    };
  }
  const found = new Set<PrefixCause>();
  if (previous.tools !== next.tools) found.add("tools_changed");
  if (previous.system !== next.system) found.add("system_changed");
  if (previous.thinking !== next.thinking) found.add("thinking_changed");
  if (previous.toolChoice !== next.toolChoice) found.add("tool_choice_changed");
  if (options.accountChanged) found.add("account_changed");

  const shared = Math.min(previous.messages.length, next.messages.length);
  let firstDivergentIndex = -1;
  for (let index = 0; index < shared; index++) {
    if (previous.messages[index] !== next.messages[index]) {
      firstDivergentIndex = index;
      found.add("history_mutated");
      break;
    }
  }
  if (firstDivergentIndex === -1 && next.messages.length < previous.messages.length) {
    firstDivergentIndex = next.messages.length;
    found.add("history_truncated");
  }
  const causes = CAUSE_ORDER.filter((cause) => found.has(cause));
  return {
    messageCount: next.messages.length,
    previousMessageCount: previous.messages.length,
    stablePrefixMessages: firstDivergentIndex === -1 ? shared : firstDivergentIndex,
    firstDivergentIndex,
    cause: causes[0] ?? "none",
    causes: causes.length ? causes : ["none"],
  };
}

interface ConversationEntry {
  fingerprint: PrefixFingerprint;
  connectionId: string | null;
  requestIndex: number;
  expiresAt: number;
}

const TTL_MS = 30 * 60 * 1000;
const MAX_CONVERSATIONS = 2000;
const conversations = new Map<string, ConversationEntry>();

export function resetPrefixObservations(): void {
  conversations.clear();
}

/**
 * Records this request in the conversation's memory and returns what changed since the previous
 * one. The key must identify the conversation, NOT its prefix (see `conversationKeyOf`).
 */
export function observePrefix(input: {
  conversationKey: string;
  body: JsonRecord | null | undefined;
  connectionId?: string | null;
  now?: number;
}): PrefixObservation {
  const now = input.now ?? Date.now();
  const fingerprint = fingerprintBody(input.body);
  const connectionId = input.connectionId ?? null;
  const previous = conversations.get(input.conversationKey);
  const live = previous && previous.expiresAt > now ? previous : null;
  const diff = diffFingerprints(live?.fingerprint ?? null, fingerprint, {
    accountChanged: !!live && !!connectionId && !!live.connectionId && live.connectionId !== connectionId,
  });
  const requestIndex = (live?.requestIndex ?? 0) + 1;
  if (!conversations.has(input.conversationKey) && conversations.size >= MAX_CONVERSATIONS) {
    const oldest = conversations.keys().next().value;
    if (oldest !== undefined) conversations.delete(oldest);
  }
  conversations.delete(input.conversationKey);
  conversations.set(input.conversationKey, {
    fingerprint,
    connectionId,
    requestIndex,
    expiresAt: now + TTL_MS,
  });
  return { conversationKey: input.conversationKey, requestIndex, ...diff };
}

const firstUserText = (body: JsonRecord): string => {
  const first = messagesOf(body).find((message) => {
    const record = asRecord(message);
    return record.role === "user" || record.type === "message" || record.role === undefined;
  });
  return digest(first);
};

/**
 * Identifies a conversation across turns WITHOUT depending on `tools`/`system` (those are exactly
 * what we want to notice changing): the key holder, the provider/model and the first user turn.
 */
export function conversationKeyOf(input: {
  body: JsonRecord | null | undefined;
  apiKeyId?: string | null;
  provider?: string | null;
  model?: string | null;
}): string {
  const body = asRecord(input.body);
  return digest([input.apiKeyId ?? "", input.provider ?? "", input.model ?? "", firstUserText(body)]);
}
