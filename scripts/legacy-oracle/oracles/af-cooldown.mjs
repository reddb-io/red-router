// The cooldown side of the legacy `checkFallbackError`: for each status, body
// and provider, the cooldown at backoff levels 0 and 3, so a level-independent
// (explicit) cooldown can be told apart from the scaled backoff.
import { writeFileSync } from "node:fs";
Date.now = () => 1_700_000_000_000;
const m = await import(process.argv[2] + "/open-sse/services/accountFallback.ts");

const samples = [
  "",
  "rate limit exceeded",
  "insufficient credits",
  "account has been deactivated",
  "daily limit reached",
  "invalid request",
  "internal server error",
  "Monthly usage limit reached. Resets in 13 days.",
  "monthly usage limit reached",
  "organization_quota_exceeded",
  "Upstream request failed: Model is unavailable.",
  "You have used up your daily free allocation of 10,000 neurons",
  "Usage limit reached for your plan",
  "You have reached your weekly usage limit",
  "Session limit reached",
  "You have used all the included free usage",
  "Please try again in 90s.",
  "Rate limit reached. Please try again in 2 minutes.",
  "额度不足",
  "无权访问模型",
];
const statuses = [400, 401, 402, 403, 404, 408, 413, 429, 500, 502, 503];
const providers = [null, "openai", "openrouter", "opencode-go", "cloudflare-ai", "agentrouter", "agy", "claude", "codex"];

const rows = [];
for (const status of statuses) for (const text of samples) for (const provider of providers) {
  const at = (level) => {
    try {
      return JSON.parse(JSON.stringify(m.checkFallbackError(status, text, level, null, provider, null, null, null, null, { nowMs: 1_700_000_000_000 })));
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  };
  const low = at(0);
  const high = at(3);
  rows.push([
    status,
    text,
    provider,
    low.shouldFallback === true ? 1 : 0,
    low.reason ?? null,
    low.cooldownMs ?? 0,
    high.cooldownMs ?? 0,
    low.ruleScope ?? null,
    low.usedUpstreamRetryHint === true ? 1 : 0,
    low.creditsExhausted === true ? 1 : 0,
    low.permanent === true ? 1 : 0,
    low.quotaResetHintMs ?? 0,
  ]);
}
writeFileSync(process.argv[3], JSON.stringify(rows));
const explicit = rows.filter((row) => row[5] > 0 && row[5] === row[6] && !row[8] && !row[9] && !row[10]);
console.log(`${rows.length} rows, ${explicit.length} level-independent cooldowns`);
