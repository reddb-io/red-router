import { describe, expect, it } from "vitest";

describe("console log buffer", () => {
  it("keeps each console call as a timestamped entry with its level", async () => {
    const { initConsoleLogCapture, getConsoleLogs, clearConsoleLogs } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();
    clearConsoleLogs();
    const before = Date.now();
    console.warn("[AUTH] slow account", { ms: 400 });
    console.log("plain line");
    const logs = getConsoleLogs().slice(-2);
    expect(logs[0]).toMatchObject({ level: "warn", text: '[AUTH] slow account {"ms":400}' });
    expect(logs[1]).toMatchObject({ level: "info", text: "plain line" });
    expect(logs[0].t).toBeGreaterThanOrEqual(before);
    expect(logs[1].id).toBeGreaterThan(logs[0].id);
  });
});
