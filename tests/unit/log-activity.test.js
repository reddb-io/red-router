import { describe, expect, it } from "vitest";
import { bucketByMinute, levelOf, recentActivity, MINUTE_MS } from "@/shared/utils/logActivity";

const now = Date.UTC(2026, 8, 25, 15, 30, 20);
const at = (minutesAgo, level = "info", text = "line") => ({ t: now - minutesAgo * MINUTE_MS, level, text });

describe("console log activity", () => {
  it("reads levels from the console method, and from markers in plain logs", () => {
    expect(levelOf({ level: "error", text: "x" })).toBe("error");
    expect(levelOf({ level: "info", text: "⚠️ [AUTH] slow" })).toBe("warn");
    expect(levelOf({ level: "info", text: "Error: boom" })).toBe("error");
    expect(levelOf({ level: "info", text: "fine" })).toBe("info");
  });

  it("counts entries per minute for the last N minutes, oldest first, by level", () => {
    const buckets = bucketByMinute([at(0), at(0, "warn"), at(1, "error"), at(29), at(31), { t: null, text: "no time" }], { now, minutes: 30 });
    expect(buckets).toHaveLength(30);
    expect(buckets[29]).toMatchObject({ info: 1, warn: 1, total: 2 });
    expect(buckets[28]).toMatchObject({ error: 1, total: 1 });
    expect(buckets[0].total).toBe(1);
    expect(buckets.reduce((n, b) => n + b.total, 0)).toBe(4);
    expect(buckets[29].start).toBe(Math.floor(now / MINUTE_MS) * MINUTE_MS);
  });

  it("summarises the last five minutes", () => {
    const buckets = bucketByMinute([at(0), at(1, "error"), at(2, "warn"), at(3), at(4), at(9)], { now, minutes: 30 });
    expect(recentActivity(buckets, 5)).toEqual({ total: 5, perMinute: 1, warn: 1, error: 1 });
  });
});
