import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SERIES_COLORS, seriesColor, DANGER_COLOR } from "@/shared/utils/chartColors";

const root = path.resolve(import.meta.dirname, "../..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const CHARTS = [
  "src/app/(dashboard)/dashboard/usage/components/UsageChart.js",
  "src/app/(dashboard)/dashboard/usage/components/ProviderBarChart.js",
  "src/app/(dashboard)/dashboard/usage/components/TopModelsChart.js",
  "src/app/(dashboard)/dashboard/pxpipe/PxpipeClient.js",
];

describe("chart colours follow the design system series", () => {
  it("uses custom properties every colour scheme defines", () => {
    const schemes = ["vendor/ds/theme/scheme-light.css", "vendor/ds/theme/scheme-dark.css"].map(read);
    for (const value of [...SERIES_COLORS, DANGER_COLOR]) {
      const name = value.match(/var\((--[a-z0-9-]+)\)/)[1];
      for (const css of schemes) expect(css, name).toContain(`${name}:`);
    }
  });

  it("cycles through the six series", () => {
    expect(seriesColor(0)).toBe("var(--reddb-color-series-1)");
    expect(seriesColor(6)).toBe(seriesColor(0));
  });

  it("leaves no hard-coded series colours in the charts", () => {
    for (const file of CHARTS) expect(read(file), file).not.toMatch(/(fill|stroke|stopColor|color)[=:]\s*["']#[0-9a-fA-F]{3,8}["']/);
  });
});
