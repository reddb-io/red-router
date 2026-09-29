// Default combos for Cursor and Claude Code: one combo per client-native model id, seeded with
// the matching provider-prefixed model so a client that asks for `claude-sonnet-4-5` (or Cursor's
// own ids) lands on a working route. Ported from 9router (src/lib/comboPresets.js). Applying is
// additive: a combo that already exists is left alone, so a preset never shadows or overwrites
// something the operator built.

import { getProviderModels } from "@omniroute/open-sse/config/providerModels.ts";
import { CLI_TOOLS } from "@/shared/constants/cliTools";

export const VALID_COMBO_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/;
export const PRESET_SOURCES = ["cursor", "claude"] as const;
export type ComboPresetSource = (typeof PRESET_SOURCES)[number];

export interface ComboPresetItem {
  name: string;
  models: string[];
  exists: boolean;
}

const CURSOR_ALIAS = "cu";
const CLAUDE_ALIAS = "cc";

/** Claude Code aliases that `defaultModels` does not list. */
const CLAUDE_EXTRA_ALIAS_TARGETS: Record<string, string> = {
  default: "cc/claude-sonnet-5",
  opusplan: "cc/claude-opus-5",
};

export function isComboPresetSource(value: unknown): value is ComboPresetSource {
  return typeof value === "string" && (PRESET_SOURCES as readonly string[]).includes(value);
}

export function isValidComboPresetName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && VALID_COMBO_NAME_REGEX.test(name);
}

type PresetSeed = { name: string; models: string[] };

function pushSeed(out: PresetSeed[], seen: Set<string>, name: unknown, models: string[]) {
  if (!isValidComboPresetName(name) || seen.has(name) || models.length === 0) return;
  seen.add(name);
  out.push({ name, models });
}

function seedsFromModels(
  list: Array<{ id?: string } | string> | undefined,
  providerAlias: string,
  seen: Set<string>
): PresetSeed[] {
  const out: PresetSeed[] = [];
  for (const entry of list ?? []) {
    const id = typeof entry === "string" ? entry : entry?.id;
    if (id) pushSeed(out, seen, id, [`${providerAlias}/${id}`]);
  }
  return out;
}

function claudeSeeds(): PresetSeed[] {
  const seen = new Set<string>();
  const out = seedsFromModels(getProviderModels(CLAUDE_ALIAS), CLAUDE_ALIAS, seen);
  const tool = (CLI_TOOLS as Record<string, any>).claude ?? {};
  for (const entry of tool.defaultModels ?? []) {
    const target = entry?.defaultValue;
    if (typeof target === "string" && target) {
      pushSeed(out, seen, entry.alias || entry.id, [target]);
    }
  }
  for (const alias of tool.modelAliases ?? []) {
    const target = CLAUDE_EXTRA_ALIAS_TARGETS[alias];
    if (target) pushSeed(out, seen, alias, [target]);
  }
  return out;
}

/** The presets for one client, marked with whether a combo of that name already exists. */
export function buildComboPresets(
  source: ComboPresetSource,
  existingNames: Iterable<string> = []
): ComboPresetItem[] {
  const existing = new Set(Array.from(existingNames, (name) => name.toLowerCase()));
  const seeds =
    source === "cursor"
      ? seedsFromModels(getProviderModels(CURSOR_ALIAS), CURSOR_ALIAS, new Set())
      : claudeSeeds();
  return seeds.map((seed) => ({ ...seed, exists: existing.has(seed.name.toLowerCase()) }));
}
