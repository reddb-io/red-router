// ADHD injector: appends the ADHD output-shaping instruction into the system
// message of the final request body, just before dispatch to the provider executor.

import { injectSystemPrompt } from "./systemInject.js";
import { ADHD_PROMPTS } from "./adhdPrompt.js";

export function injectAdhd(body, format, level) {
  injectSystemPrompt(body, format, ADHD_PROMPTS[level]);
}
