import { writeFileSync } from "node:fs";
Date.now = () => 1_700_000_000_000;
const m = await import(process.argv[2] + "/open-sse/services/accountFallback.ts");

const samples = [
  "", "rate limit exceeded", "Too many requests", "quota exceeded", "You exceeded your current quota",
  "insufficient credits", "Your credit balance is too low", "billing hard limit reached",
  "This model has been deprecated", "The model gpt-3 is no longer available", "model has been retired",
  "This endpoint has moved, update your base URL",
  "Your account has been suspended due to an unpaid invoice",
  "account has been deactivated", "Your organization has been disabled", "this account is banned",
  "invalid api key", "Invalid authentication credentials", "token expired", "invalid_grant", "unauthorized",
  "context length exceeded", "maximum context length is 8192 tokens", "prompt is too long",
  "model not found", "the model does not exist", "you do not have access to the model",
  "model_not_allowed", "not supported for format oa-compat",
  "daily limit reached", "daily quota exhausted, resets at midnight", "tokens per day limit",
  "invalid request", "unsupported parameter: temperature", "max_tokens is too large",
  "internal server error", "service unavailable", "overloaded", "gateway timeout", "bad gateway",
  "Conversation not found", "file not found",
];
const statuses = [400, 401, 402, 403, 404, 408, 410, 413, 422, 429, 500, 502, 503, 504, 529];
const providers = [null, "openai", "anthropic", "mistral", "openrouter", "codex", "claude", "antigravity", "github", "groq", "deepseek"];

const rows = [];
for (const status of statuses) for (const text of samples) for (const provider of providers) {
  let out;
  try {
    out = m.checkFallbackError(status, text, 0, null, provider, null, null, null, null, { nowMs: 1_700_000_000_000 });
  } catch (error) {
    out = { error: String(error?.message ?? error) };
  }
  rows.push({ status, text, provider, out: JSON.parse(JSON.stringify(out)) });
}
writeFileSync(process.argv[3], JSON.stringify(rows));
const reasons = {};
for (const r of rows) {
  const key = r.out.error ? "ERROR" : `${r.out.shouldFallback ? "fb" : "nofb"}:${r.out.reason ?? "-"}${r.out.permanent ? ":perm" : ""}${r.out.creditsExhausted ? ":credits" : ""}`;
  reasons[key] = (reasons[key] ?? 0) + 1;
}
console.log(rows.length, JSON.stringify(Object.entries(reasons).sort((a, b) => b[1] - a[1]), null, 0));
