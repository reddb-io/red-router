import { DefaultExecutor } from "./default.ts";
import type { ProviderCredentials } from "./base.ts";

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Ported from the legacy fork (open-sse/executors/codebuddy-intl.js @ c66f917c).
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyCnExecutor.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  transformRequest(
    model: string,
    body: unknown,
    stream: boolean,
    credentials: ProviderCredentials
  ): unknown {
    const transformed = super.transformRequest(model, body, stream, credentials);
    if (!transformed || typeof transformed !== "object" || Array.isArray(transformed)) {
      return transformed;
    }
    const out = transformed as Record<string, unknown>;
    out.stream = true;

    const eff = out.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete out.reasoning_effort;
    } else if (eff) {
      out.reasoning_summary = "auto";
    }

    // CodeBuddy rejects plain OpenAI shape (11101 invalid request): needs a
    // leading system prompt + user content as typed blocks, not a bare string.
    const source = Array.isArray(out.messages) ? out.messages : [];
    out.messages = [{ role: "system", content: "You are CodeBuddy Code." }];
    for (const rawMessage of source) {
      if (!rawMessage || typeof rawMessage !== "object") continue;
      const message = rawMessage as Record<string, unknown>;
      if (Array.isArray(message) || message.role === "system" || message.role === "developer") {
        continue;
      }
      if (message.role === "user" && typeof message.content === "string") {
        out.messages.push({
          ...message,
          content: [{ type: "text", text: message.content }],
        });
      } else {
        out.messages.push({ ...message });
      }
    }

    return out;
  }
}

export default CodeBuddyIntlExecutor;
