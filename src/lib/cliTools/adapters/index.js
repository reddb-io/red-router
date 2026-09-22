import * as pi from "./pi.js";
import * as omp from "./omp.js";
import * as crush from "./crush.js";
import * as forge from "./forge.js";
import * as smelt from "./smelt.js";
import * as codewhale from "./codewhale.js";

export const DYNAMIC_CLI_TOOL_ADAPTERS = Object.freeze({
  pi,
  omp,
  crush,
  forge,
  smelt,
  codewhale,
});

export function getDynamicCliToolAdapter(toolId) {
  return DYNAMIC_CLI_TOOL_ADAPTERS[toolId] || null;
}
