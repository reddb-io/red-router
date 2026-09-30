/**
 * Static catalog of the built-in guardrails: what each one is, when it runs and whether it can
 * rewrite traffic. Pure data with no server imports, so both the resolver and the dashboard can
 * read it. The runtime registry (registry.ts) holds the executable instances; the names here
 * must match `BaseGuardrail.name`.
 */

export type GuardrailStage = "request" | "response" | "both";

export interface GuardrailCatalogEntry {
  /** Same string as `BaseGuardrail.name`. */
  id: string;
  label: string;
  description: string;
  stage: GuardrailStage;
  /** Same value the guardrail registers with today; lower runs first. */
  defaultPriority: number;
  /** Whether the guardrail is on when nothing says otherwise. */
  defaultEnabled: boolean;
  /**
   * True when the guardrail can rewrite the request or the response. Such a guardrail is never
   * enabled implicitly by an assignment: only an explicit `enabled` entry counts (Hard Rule 20).
   */
  mutatesData: boolean;
}

export const GUARDRAIL_CATALOG: readonly GuardrailCatalogEntry[] = [
  {
    id: "vision-bridge",
    label: "Vision bridge",
    description: "Describes images for models that cannot see them.",
    stage: "request",
    defaultPriority: 5,
    defaultEnabled: true,
    mutatesData: true,
  },
  {
    id: "audio-bridge",
    label: "Audio bridge",
    description: "Transcribes audio for models that cannot hear it.",
    stage: "request",
    defaultPriority: 6,
    defaultEnabled: true,
    mutatesData: true,
  },
  {
    id: "video-bridge",
    label: "Video bridge",
    description: "Turns video into frames and transcripts for models that cannot watch it.",
    stage: "request",
    defaultPriority: 7,
    defaultEnabled: true,
    mutatesData: true,
  },
  {
    id: "content-filter",
    label: "Content filter",
    description: "Blocks or flags requests and responses that match operator-defined rules.",
    stage: "both",
    defaultPriority: 8,
    defaultEnabled: true,
    mutatesData: false,
  },
  {
    id: "pii-masker",
    label: "PII masker",
    description: "Masks personal data. Only acts when its own opt-in setting is on.",
    stage: "both",
    defaultPriority: 10,
    defaultEnabled: true,
    mutatesData: true,
  },
  {
    id: "prompt-injection",
    label: "Prompt injection guard",
    description: "Detects prompt-injection attempts in requests.",
    stage: "request",
    defaultPriority: 20,
    defaultEnabled: true,
    mutatesData: false,
  },
  {
    id: "credential-masker",
    label: "Credential masker",
    description: "Masks secrets in prompts and replies. Only acts when credential redaction is on.",
    stage: "both",
    defaultPriority: 95,
    defaultEnabled: true,
    mutatesData: true,
  },
] as const;

export const GUARDRAIL_IDS: readonly string[] = GUARDRAIL_CATALOG.map((entry) => entry.id);

export function getGuardrailCatalogEntry(id: string): GuardrailCatalogEntry | undefined {
  return GUARDRAIL_CATALOG.find((entry) => entry.id === id);
}
