import { writeFileSync } from "node:fs";
const m = await import(`${process.argv[2]}/open-sse/services/quotaResetParsing.ts`);
const now = Date.UTC(2026, 7, 1, 0, 0, 0); // 2026-08-01T00:00:00Z
const MAX = 30 * 24 * 60 * 60 * 1000;
const providers = [null, "Z", "+08:00", "-05:30", "+0200", "zai", "glm", "glm-cn", "glmcn", "glmt", "openai", "bogus"];
const messages = [
  "", "no reset here", "Your quota will reset in 3 days.", "Resets in 13 days", "reset in 1 day", "resets in 0 days", "resets in 99 days",
  "resets in 40 days", "Resets in 2 DAYS", "resets in 5 hours",
  "Your limit will reset at 2026-08-29 21:01:21", "try again at 2026-08-29T21:01:21Z", "wait until 2026-08-29T21:01:21+02:00",
  "available at 2026-08-29T21:01:21-0530", "retry after 2026-08-29 21:01", "resets at 2026-08-29T21:01:21.123456789Z", "reset at 2026-08-29T21:01:21.5",
  "reset at 2026-07-01 00:00:00", "reset at 2026-08-01 00:00:00", "reset at 2026-08-01 00:00:01", "reset at 2027-12-31 23:59:59Z",
  "reset at 2026-02-31 10:00:00", "reset at 2026-13-01 10:00:00", "reset at 2026-08-29 24:00:00", "reset at 2026-08-29 24:00:01", "reset at 2026-08-29 10:60:00",
  "reset at 2026-08-29 10:00:60", "reset at 2026-00-10 10:00", "reset at 2026-08-00 10:00", "reset at 2026-08-32 10:00",
  "[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-08-29 21:01:21]", "bigmodel.cn says reset at 2026-08-29 21:01:21", "visit z.ai reset at 2026-08-29 21:01:21",
  "The quota will reset at 08-29 15:29:00 UTC", "resets at 08-29 15:29", "reset at 07-31 23:59:59 Z", "reset at 08-01 00:00:00", "reset at 08-01 00:00:01",
  "reset at 02-30 10:00:00", "reset at 02-31 10:00", "reset at 13-01 10:00", "reset at 00-10 10:00", "reset at 12-31 24:00", "reset at 06-15 12:30:45 UTC",
  "reset at 2026-08-29 21:01:21 and resets in 3 days", "resets in 2 days or reset at 2026-08-29 21:01:21",
  "reset at 2026-09-29 21:01:21", "reset at 2027-08-29 21:01:21", "RESET AT 2026-08-29 21:01:21Z", "Reset At 2026-08-29t21:01:21z",
];
const parse = [];
for (const message of messages) for (const provider of providers) {
  parse.push([message, provider,
    m.parseDayGranularityResetMs(message, MAX, now, provider),
    m.parseIsoDateTimeResetMs(message, MAX, now, provider),
    m.parseMonthDayResetMs(message, MAX, now)]);
}
const zone = [];
for (const message of ["", "plain", "[1308] bad", "[1310]", "see z.ai", "Z.AI", "xz.ai", "bigmodel.cn", "BIGMODEL.CN", "a.bigmodel.cn.x"]) for (const provider of providers.concat(["+0800", "z", "+08", "-0530"])) {
  zone.push([message, provider, m.resolveNaiveResetZone(message, provider)]);
}
writeFileSync(process.argv[3], JSON.stringify({ now, parse, zone }));
console.log("ok", parse.length, zone.length);
