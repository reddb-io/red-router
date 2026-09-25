// One sentence each on what the Autopilot's two features do right now, from
// their settings (the Autopilot page and its cards).
import { translate } from "@/i18n/runtime";
import { publicModelRef } from "@/shared/utils/modelRef";

/** One sentence on what the router does right now, from its settings. */
export function decisionRouterSummary(config) {
  const scope = (config.models || []).map(publicModelRef);
  const where = scope.length ? scope.slice(0, 3).join(", ") + (scope.length > 3 ? ` +${scope.length - 3}` : "") : null;
  if (config.mode === "off") return translate("Off. Combos serve requests in their own order (fallback, round-robin…).");
  if (!where) return translate("No combo or model chosen yet, so it has nothing to pick from. Add one below.");
  if (config.mode === "shadow") return `${translate("Test run on")} ${where}: ${translate("it decides which model should serve each turn and logs it, but the combo's own order still serves. Compare in Usage → Details.")}`;
  return `${translate("On for")} ${where}: ${translate("the decision model picks which model serves each turn.")}`;
}

function scopeText(config) {
  if (config.all) return translate("every request");
  const parts = [];
  if (config.apiKeys?.length) parts.push(`${config.apiKeys.length} ${translate(config.apiKeys.length === 1 ? "API key" : "API keys")}`);
  if (config.combos?.length) parts.push(`${config.combos.length} ${translate(config.combos.length === 1 ? "combo" : "combos")}`);
  return parts.join(` ${translate("and")} `);
}

/** One sentence on what the autopilot does right now, from its settings. */
export function reasoningAutopilotSummary(config) {
  if (config.mode === "off") return translate("Off. Each request thinks as much as the client asked for.");
  const scope = scopeText(config);
  if (!scope) return translate("Nothing chosen yet: pick every request, or some API keys or combos, below.");
  const range = `${config.floor}–${config.ceiling}`;
  if (config.mode === "shadow") return `${translate("Test run on")} ${scope}: ${translate("it picks a level per turn and logs it; requests keep the client's level.")}`;
  return `${translate("On for")} ${scope}: ${translate("thinks more on hard steps, plan mode and stuck tool loops, less on mechanical steps, always within")} ${range}.`;
}
