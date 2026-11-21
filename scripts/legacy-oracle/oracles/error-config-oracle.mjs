import { writeFileSync } from "node:fs";
const m = await import(`${process.argv[2]}/open-sse/config/errorConfig.ts`);
const clean = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
const messages = [
  "", "Rate limit exceeded", "TOO MANY REQUESTS", "no credentials found", "Request not allowed", "improperly formed request", "hour quota hit",
  "quota has been exceeded for the day", "Quota Exceeded", "your quota will reset in 3 hours", "You have exhausted your capacity", "quota exhausted",
  "The free tier of the model has been exhausted", "out of extra usage", "extra usage required", "Model capacity reached", "overloaded", "High Demand right now",
  "capacity", "plain error", "internal server error", "rate limit and capacity", "no credentials, rate limit",
];
const statuses = [200, 400, 401, 402, 403, 404, 406, 408, 413, 429, 500, 502, 503, 504, 529];
const out = {
  rules: m.ERROR_RULES.map((r) => clean(r)),
  text: messages.map((x) => [x, clean(m.matchErrorRuleByText(x))]),
  status: statuses.map((s) => [s, clean(m.matchErrorRuleByStatus(s))]),
  find: [],
  backoff: [-3, -0.5, 0, 0.9, 1, 2.7, 5, 6, 7, 14, 15, 16, 40].map((l) => [l, m.calculateBackoffCooldown(l)]),
  nim: [
    'Function id "abc" submitted for inference is DEGRADED', "DEGRADED function", "the function is degraded", "function ".padEnd(200, "x") + " DEGRADED", "degraded only", "function only", "disfunction degraded", "functional DEGRADED",
    "DEGRADED " + "y".repeat(70) + " function", "DEGRADED " + "y".repeat(90) + " function",
  ].map((t) => [t, m.isNimFunctionDegraded(t)]),
  supervisor: [],
};
for (const s of statuses) for (const x of messages) out.find.push([s, x, clean(m.findMatchingErrorRule(s, x))]);
for (const status of [200, 500, 503]) for (const hint of [null, "connection_cooldown", "CONNECTION_COOLDOWN", "other", ""]) {
  for (const noHeaders of [false, true]) {
    const headers = noHeaders ? null : hint === null ? {} : { "x-omni-fallback-hint": hint };
    out.supervisor.push([status, hint, noHeaders, clean(m.serviceSupervisorCooldown(status, headers))
      ? (({ cooldownMs, reason }) => ({ cooldownMs, reason }))(m.serviceSupervisorCooldown(status, headers)) : null]);
  }
}
writeFileSync(process.argv[3], JSON.stringify(out));
console.log("ok", out.rules.length, out.find.length, out.supervisor.length);
