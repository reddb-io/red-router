import { writeFileSync } from "node:fs";
const m = await import(`${process.argv[2]}/open-sse/services/quotaTextCooldowns.ts`);
const now = Date.UTC(2026, 7, 1, 0, 0, 0);
const clean = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
const texts = [
  "", "plain error", "Usage Limit Reached", "usage limit has been reached", "Claude Pro usage limit", "You've reached your usage limit", "you have reached your usage limit for today",
  "this exceeds your plan", "plan limit exceeded", "plan's set usage limit", "usage limit exceeded", "Plan Limit",
  "This request would exceed your account's rate limit.", "this request would exceed your account's rate limit",
  "you (acct) have reached your weekly usage limit", "weekly limit reached", "You reached your weekly cap", "1-week quota exhausted", "Week Quota hit",
  "weekly/monthly limit exhausted. your limit will reset at 2026-08-29 21:01:21", "weekly usage limit. resets in 3 days", "weekly usage limit. resets in 90 days",
  "weekly quota exhausted", "weekly quota", "the weekly thing is exhausted but quota missing", "weekly usage limit reset at 2026-07-01 00:00:00",
  "weekly usage limit. the quota will reset at 08-29 15:29:00 UTC", "[1310] weekly/monthly limit exhausted reset at 2026-08-29 21:01:21 bigmodel.cn",
  "you (x) have reached your session usage limit", "session limit reached", "reached your session usage limit", "reached your session", "session expired", "session token invalid",
  "You've used all the included free usage for model grok-4.6 for now.", "Usage resets over a rolling 24-hour window — tokens (actual/limit): 5/10.", "rolling 24-hour window", "tokens (actual/limit)",
  "usage limit reached and weekly usage limit and session usage limit", "daily limit reached",
];
const providers = [null, "claude", "openai", "zai"];
const hints = [[null, null], [120000, 5000], [0, 777]];
const cases = [];
for (const text of texts) for (const provider of providers) for (const [hint, bodyHint] of hints) {
  cases.push({
    text, provider, hint, bodyHint,
    subscription: clean(m.buildSubscriptionQuotaFallback(text, () => hint, () => bodyHint, provider)),
    weekly: clean(m.buildWeeklyQuotaFallback(text, now, provider)),
    session: clean(m.buildSessionQuotaFallback(text)),
    rolling: clean(m.buildRolling24hQuotaFallback(text)),
  });
}
writeFileSync(process.argv[3], JSON.stringify({ now, cases }));
console.log("ok", cases.length);
