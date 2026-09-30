/**
 * Runtime glue between the guardrail registry and the operator's settings: builds the per-request
 * plan (assignments + content filter) and the fire-and-forget event recorder. The registry itself
 * stays free of database access, so a request with no plan runs exactly as it always did.
 */

import { getSettings } from "@/lib/db/settings";
import { getKeyGroupsForApiKey } from "@/lib/db/apiKeyGroups";
import { recordGuardrailEvent } from "@/lib/db/guardrailEvents";
import type { GuardrailEventInput, GuardrailPlan } from "./base";
import {
  hasGuardrailAssignments,
  normalizeGuardrailAssignments,
  resolveGuardrails,
  type GuardrailAssignments,
} from "./assignment";
import { normalizeContentFilterConfig, type ContentFilterConfig } from "./contentFilterRules";

export interface GuardrailSettingsSnapshot {
  assignments: GuardrailAssignments;
  contentFilter: ContentFilterConfig;
}

/**
 * Pure: builds the plan for one request from the stored settings, or null when nothing is
 * configured (assignments empty and content filter off) so callers keep the legacy path.
 */
export function buildGuardrailPlan(
  snapshot: GuardrailSettingsSnapshot,
  identity: { keyId?: string | null; groupIds?: readonly string[] }
): GuardrailPlan | null {
  const assigned = hasGuardrailAssignments(snapshot.assignments);
  if (!assigned && !snapshot.contentFilter.enabled) return null;

  const entries: GuardrailPlan["entries"] = {};
  if (assigned) {
    for (const item of resolveGuardrails({ ...identity, assignments: snapshot.assignments })) {
      entries[item.id] = { enabled: item.enabled, priority: item.priority };
    }
  }

  // The content filter needs its own master switch on AND to survive the assignments.
  const filterEnabled = snapshot.contentFilter.enabled && entries["content-filter"]?.enabled !== false;
  return { entries, contentFilter: filterEnabled ? snapshot.contentFilter : null };
}

const SNAPSHOT_TTL_MS = 2000;
let cached: { at: number; snapshot: GuardrailSettingsSnapshot } | null = null;

/** Drops the short settings cache (used after a settings write and in tests). */
export function resetGuardrailRuntimeCache(): void {
  cached = null;
}

async function readSnapshot(now: number): Promise<GuardrailSettingsSnapshot> {
  if (cached && now - cached.at < SNAPSHOT_TTL_MS) return cached.snapshot;
  const settings = await getSettings();
  const snapshot: GuardrailSettingsSnapshot = {
    assignments: normalizeGuardrailAssignments(settings.guardrailAssignments),
    contentFilter: normalizeContentFilterConfig(settings.guardrailContentFilter),
  };
  cached = { at: now, snapshot };
  return snapshot;
}

/** Resolves the plan for a request. Fails open (no plan) if settings cannot be read. */
export async function loadGuardrailPlan({
  apiKeyInfo,
}: {
  apiKeyInfo?: Record<string, unknown> | null;
}): Promise<GuardrailPlan | null> {
  try {
    const snapshot = await readSnapshot(Date.now());
    const keyId = typeof apiKeyInfo?.id === "string" ? apiKeyInfo.id : null;
    const needsGroups = keyId !== null && Object.keys(snapshot.assignments.byGroup).length > 0;
    const groupIds = needsGroups ? getKeyGroupsForApiKey(keyId).map((group) => group.id) : [];
    return buildGuardrailPlan(snapshot, { keyId, groupIds });
  } catch {
    return null;
  }
}

/** Builds the `recordEvent` sink for one request; the write happens off the request's path. */
export function createGuardrailEventRecorder({
  apiKeyInfo,
  requestId,
}: {
  apiKeyInfo?: Record<string, unknown> | null;
  requestId?: string | null;
}): (event: GuardrailEventInput) => void {
  const apiKeyId = typeof apiKeyInfo?.id === "string" ? apiKeyInfo.id : null;
  return (event) => {
    queueMicrotask(() => {
      recordGuardrailEvent({
        guardrailId: event.guardrailId,
        stage: event.stage,
        action: event.action,
        ruleId: event.ruleId ?? null,
        apiKeyId,
        requestId: requestId ?? null,
      });
    });
  };
}
