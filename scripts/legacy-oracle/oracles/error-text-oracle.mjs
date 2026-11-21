import { writeFileSync } from "node:fs";
const NOW = Date.UTC(2026, 7, 1, 0, 0, 0);
Date.now = () => NOW;
const rj = await import(`${process.argv[2]}/open-sse/services/retryAfterJson.ts`);
const af = await import(`${process.argv[2]}/open-sse/services/accountFallback.ts`);
const MAX = 30 * 24 * 60 * 60 * 1000;
const clean = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));

const delays = [
  "33s", "26.660853464s", "2m", "1h", "1500ms", "1.5s", "0.5ms", "10", "10.5", " 7 s ", "1 H", "5MS", "abc", "12abc", "", null, undefined, 0, 5, 2.5, -3, "-3", "-1.5", "-0.0005", ".5", "1e3", "1e3s", "Infinity", "+4", true, false, [], {}, "0", "0s", "  ", "3 seconds", "2h3m",
];
const delay = delays.map((d) => [d === undefined ? null : d, rj.parseDelayString(d)]);

const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const jsonBodies = [
  "", "not json", "[]", "{}", "null", "5", '"s"',
  { error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "26s" }] } },
  { error: { details: [{ "@type": "x.RetryInfo", retryDelay: "2000h" }] } },
  { details: [{ "@type": "RetryInfo", retryDelay: "5s" }] },
  { error: { details: [{ "@type": "other", retryDelay: "5s" }, { "@type": "RetryInfo", retryDelay: "0s" }, { "@type": "RetryInfo", retryDelay: "9s" }] } },
  { error: { details: "nope" }, details: [{ "@type": "RetryInfo", retryDelay: "4s" }] },
  { error: { details: null }, details: [{ "@type": "RetryInfo", retryDelay: "4s" }] },
  { error: { resets_at: Math.floor((NOW + 3600000) / 1000) } }, { resets_at: NOW + 7200000 }, { error: { resetsAt: Math.floor((NOW + 1800000) / 1000) } },
  { error: { resets_at: String(Math.floor((NOW + 3600000) / 1000)) } }, { error: { resets_at: "1700000000" } }, { error: { resets_at: iso(5400000) } }, { error: { resets_at: Math.floor((NOW - 1000) / 1000) } },
  { error: { resets_at: 1e15 } }, { error: { resets_at: Math.floor((NOW + 90 * 86400000) / 1000) } }, { error: { resets_at: -5 } }, { error: { resets_at: "12abc" } }, { error: { resets_at: "3.5" } },
  { error: { retryAfter: iso(60000) } }, { retryAfter: iso(120000) }, { retryAfter: iso(-60000) }, { retryAfter: "garbage" }, { retryAfter: 5 },
  { retryAfter: "Sat, 01 Aug 2026 00:05:00 GMT" }, { retryAfter: "2026-08-01T00:10:00+01:00" }, { retryAfter: "2026-08-01T00:10:00" }, { retryAfter: "2026-08-02" }, { retryAfter: "2026-08-01T00:10" },
  { error: { retry_after_ms: 1500 } }, { retry_after_ms: 9e9 }, { retryAfterMs: 2500 }, { error: { retryAfterMs: 0 } }, { retry_after_ms: -1 }, { retry_after_ms: "1500" },
  { error: { retry_after_ms: 4000 }, retryAfter: iso(60000) }, { error: { resets_at: Math.floor((NOW + 3600000) / 1000), retry_after_ms: 10 } },
  { error: { details: [{ "@type": "RetryInfo", retryDelay: "3s" }], resets_at: Math.floor((NOW + 3600000) / 1000) } },
].map((b) => (typeof b === "string" ? b : JSON.stringify(b)));
const json = jsonBodies.map((b) => [b, clean(rj.parseDetailedRetryHintFromJsonBody(b, MAX))]);

const providers = [null, "zai", "openai"];
const texts = [
  "", "no hint at all", "Please retry in 26.660853464s.", "please retry in 5s", "please retry in 99999999s", "Please retry in 0s",
  "Your quota will reset after 2h5m10s", "resets after 45m", "will reset after 3h", "Resets in 164h27m24s", "resets in 30s", "resets in 0h0m0s",
  "resets after 5000h", "reset after 1h30m", "Resets in 3 days.", "reset at 2026-08-29 21:01:21", "try again at 2026-08-01T01:00:00Z", "retry after 2026-08-01T00:30:00+02:00",
  "[1310] limit will reset at 2026-08-29 21:01:21 bigmodel.cn", "The quota will reset at 08-29 15:29:00 UTC", "please retry in 12.5 s and resets in 2h",
  JSON.stringify({ error: { retry_after_ms: 1500 } }), JSON.stringify({ error: { details: [{ "@type": "RetryInfo", retryDelay: "26s" }] } }),
  "Resets after 1h and please retry in 3s", "resets in 5m or reset at 2026-08-29 21:01:21", "reset in 4h", "reset after 10s",
];
const text = [];
for (const t of texts) for (const p of providers) text.push([t, p, clean(af.parseRetryFromErrorText(t, p, NOW))]);

const classifyTexts = [
  "", "Quota exceeded", "quota depleted", "Your quota will reset in 3h", "quota has been exceeded", "hour quota", "billing issue", "daily limit reached", "out of credits",
  "Usage Limit Reached", "plan limit exceeded", "insufficient_quota", "You exceeded your current quota", "credit balance is too low", "payment required",
  "account has been deactivated", "your account has been suspended", "this account is deactivated",
  "no credentials", "request not allowed", "improperly formed request", "rate limit", "too many requests", "capacity", "overloaded", "high demand", "exhausted your capacity",
  "rate_limit_exceeded", "resource exhausted", "RESOURCE EXHAUSTED", "unauthorized", "invalid api key", "authentication failed", "server error", "internal error", "something else",
  "free tier of the model has been exhausted", "out of extra usage", "extra usage required", "quota exhausted", "individual quota reached", "enable overages",
  "rate limit and quota exceeded", "unauthorized billing", "plan limit rate limit",
];
const classify = classifyTexts.map((t) => [t, af.classifyErrorText(t)]);
writeFileSync(process.argv[3], JSON.stringify({ now: NOW, delay, json, text, classify }));
console.log("ok", delay.length, json.length, text.length, classify.length);
