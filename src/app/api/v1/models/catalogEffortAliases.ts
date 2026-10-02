import { codexProvider } from "@omniroute/open-sse/config/providers/registry/codex";
import { GLM_SHARED_MODELS } from "@omniroute/open-sse/config/glmProvider";
import { splitCodexReasoningSuffix } from "@omniroute/open-sse/executors/codex/reasoningSuffix";

type CatalogEntry = {
  id?: unknown;
  root?: unknown;
  owned_by?: unknown;
  type?: unknown;
  subtype?: unknown;
  remoteCapabilities?: unknown;
  [key: string]: unknown;
};

// Only aliases whose executor sends the base ID plus an effort parameter.
// Never infer aliases for arbitrary providers from a suffix: Cursor/Devin and
// remote routers can expose real upstream IDs ending in -high/-max.
const codexIds = new Set(codexProvider.models.map((model) => model.id));
const codexAliases = new Map<string, string>();
for (const id of codexIds) {
  const { baseModel, effort } = splitCodexReasoningSuffix(id);
  if (effort && codexIds.has(baseModel)) codexAliases.set(id, baseModel);
}

const glmAliases = new Map<string, string>();
for (const model of GLM_SHARED_MODELS) {
  // GLM 5.2 effort aliases also select a different transport. Keep those until
  // its base-model parameter path provides equivalent transport selection.
  if (model.id !== "glm-5.3" && model.id !== "glm-5.3-flash") continue;
  for (const effort of model.supportedThinkingEfforts) {
    const alias = `${model.id}-${effort}`;
    if (GLM_SHARED_MODELS.some((entry) => entry.id === alias)) {
      glmAliases.set(alias, model.id);
    }
  }
}

function route(entry: CatalogEntry): { prefix: string; root: string } | null {
  if (typeof entry.id !== "string") return null;
  const root = typeof entry.root === "string" ? entry.root : entry.id.split("/").at(-1)!;
  if (!root || !entry.id.endsWith(root)) return null;
  const prefix = entry.id.slice(0, -root.length);
  if (prefix && !prefix.endsWith("/")) return null;
  return { prefix, root };
}

function identity(entry: CatalogEntry, id: string): string {
  return JSON.stringify([entry.owned_by, id, entry.type, entry.subtype]);
}

/** The input must already be filtered by key, tenant and connection policy. */
export function hideRegisteredEffortAliases<T extends CatalogEntry>(models: T[]): T[] {
  const visible = new Set(models.map((entry) => identity(entry, String(entry.id))));
  return models.filter((entry) => {
    if (entry.type !== undefined && entry.type !== "chat") return true;
    if (entry.remoteCapabilities !== undefined) return true;
    const target = route(entry);
    if (!target) return true;
    const aliases =
      entry.owned_by === "codex" || entry.owned_by === "codex-app-server"
        ? codexAliases
        : ["glm", "glm-cn", "glmt"].includes(String(entry.owned_by))
          ? glmAliases
          : undefined;
    const base = aliases?.get(target.root);
    return !base || !visible.has(identity(entry, `${target.prefix}${base}`));
  });
}
