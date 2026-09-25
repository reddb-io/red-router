import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(path, import.meta.url));

describe("RedDB brand icons", () => {
  it("keeps every browser and PWA SVG on the canonical RedDB mark", () => {
    // The Brand's colour icon Mark, as the design system Sync vendors it.
    const canonical = read("../../vendor/ds/kits/base/src/marks/reddb-icon-color.svg");

    expect(read("../../public/favicon.svg")).toEqual(canonical);
    expect(read("../../public/icons/icon-192.svg")).toEqual(canonical);
    expect(read("../../public/icons/icon-512.svg")).toEqual(canonical);
  });

  it("uses the same multiresolution RedDB icon for the browser and system tray", () => {
    expect(read("../../src/app/favicon.ico")).toEqual(
      read("../../cli/src/cli/tray/icon.ico"),
    );
  });

  it("shows the RedRouter name beside its system tray icon", () => {
    expect(read("../../cli/src/cli/tray/tray.js").toString()).toContain(
      'title: "RedRouter"',
    );
  });
});
