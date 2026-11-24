import { writeFileSync } from "node:fs";
const m = await import(`${process.argv[2]}/open-sse/config/providerErrorRules.ts`);
const clean = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));

const providers = [null, "opencode", "opencode-go", "OpenCode-Zen", "opencode-cli", "minimax", "minimax-passthrough", "cloudflare-ai", "openrouter", "agentrouter", "AgentRouter", "openai", "unknown"];
const statuses = [400, 402, 403, 429, 500];
const headerSets = [
  {}, { "x-ratelimit-remaining-requests": "0" }, { "x-ratelimit-remaining-tokens": "0" }, { "x-ratelimit-remaining-requests": "5" },
  { "x-model-quota-remaining": "haiku=0,sonnet=42" }, { "x-model-quota-remaining": "haiku=3,sonnet=42" }, { "x-model-quota-remaining": "a=b=0" }, { "x-model-quota-remaining": " a = 0 ,b=1" },
];
const bodies = [
  null, "", "plain text", { error: { message: "x" } },
  "[429] Monthly usage limit reached. Resets in 13 days. To continue using this model now, enable usage",
  { error: { message: "Monthly usage limit reached. Resets in 2 hours." } },
  "Monthly usage limit reached.", "Monthly usage limit reached. Resets in 0 days.",
  "Monthly usage limit reached. resets in 30 Minutes.",
  { code: "organization_quota_exceeded" }, { code: "account_quota_exceeded" }, "plan_limit_reached",
  "Upstream request failed: Model is unavailable.", { error: { message: "Upstream request failed: Model is unavailable." } },
  "you have used up your daily free allocation of 10,000 neurons",
  "额度不足", "用户额度不足,请充值", "无权访问模型 gpt", { message: "无权访问模型" },
];
const operatorSets = [[], [{ status: 429, match: "Custom Limit", scope: "model", reason: "rate_limit_exceeded", cooldownMs: 1234 }, { status: 429, match: "other", scope: "provider" }]];
const match = [];
const headerDriven = (p) => p && (p.toLowerCase().startsWith("opencode") || p.toLowerCase().startsWith("minimax"));
const smallBodies = [null, "plain text", bodies[4], bodies[9], bodies[12]];
for (const provider of providers) for (const status of statuses) {
  const headerList = headerDriven(provider) ? headerSets : [{}];
  const bodyList = headerDriven(provider) ? smallBodies : bodies;
  for (const headers of headerList) for (const body of bodyList) {
    match.push({ provider, status, headers, body, operator: [], result: clean(m.getProviderErrorRuleMatch(provider, status, headers, body)) });
  }
}
// operator rules, bodies as strings and objects
for (const provider of ["openai", "opencode", "OpenAI"]) for (const status of [429, 500]) for (const body of ["a CUSTOM limit hit", { error: "custom limit" }, "other thing", "nothing", null]) {
  match.push({ provider, status, headers: {}, body, operator: operatorSets[1], result: clean(m.getProviderErrorRuleMatch(provider, status, {}, body, { [provider.toLowerCase()]: operatorSets[1] })) });
}
const countdown = [
  "resets in 13 days.", "resets in 1 day", "reset in 2 hours", "resets in 1 hour", "resets in 30 minutes.", "resets in 5 minute", "resets in 45 seconds", "resets in 1 second",
  "Resets in 13 days", "resets in 0 days", "resets in x days", "resets in 3 weeks", "no countdown", "", "resets  in   7   days", "resets in 10 daysx",
].map((t) => [t, m.parseResetCountdownMs(t)]);
const unavailable = [];
for (const provider of [null, "opencode", "opencode-go", "openai", "minimax"]) for (const status of [400, 429]) for (const body of ["Upstream request failed: Model is unavailable.", { error: { message: "Upstream request failed: Model is unavailable." } }, "other", null]) {
  unavailable.push({ provider, status, body, result: clean(m.getOpencodeModelUnavailableMatch(provider, status, {}, body)) });
}
const scope = [];
for (const provider of [null, "", "agentrouter", "AgentRouter", "opencode", "opencode-zen", "opencode-go", "opencode-cli", "openai", "openrouter", "minimax"]) {
  for (const operator of [false, true]) {
    m.setOperatorProviderErrorRules(operator && provider ? { [provider]: [{ status: 429, match: "x", scope: "model" }] } : null);
    scope.push({ provider, operator, honors: m.honorsRuleLockScope(provider), egress: m.isEgressBucketedLockScope(provider) });
  }
}
const bodyCases = [];
for (const provider of [null, "agentrouter", "AgentRouter", "openai", "opencode"]) for (const operator of [false, true]) for (const text of [null, "", "full error text"]) for (const structured of [null, { code: "c", type: "t" }]) {
  m.setOperatorProviderErrorRules(operator && provider ? { [provider]: [{ status: 429, match: "x", scope: "model" }] } : null);
  bodyCases.push({ provider, operator, text, structured, result: clean(m.resolveRuleMatchBody(provider, structured, text)) });
}
writeFileSync(process.argv[3], JSON.stringify({ match, countdown, unavailable, scope, body: bodyCases }));
console.log("ok", match.length, countdown.length, unavailable.length, scope.length, bodyCases.length);
