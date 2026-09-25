import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Every dashboard page fills the layout's page frame (DashboardLayout): a page
// that sets its own max width and centers itself starts at a different x than
// the next page. Dialogs and the full-height chat are the exceptions.
const root = path.resolve(import.meta.dirname, "../..");
const dashboard = path.join(root, "src/app/(dashboard)/dashboard");

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : e.name.endsWith(".js") ? [p] : [];
  });
}

describe("dashboard page frame", () => {
  it("no page centers itself inside a narrower max width", () => {
    const offenders = [];
    for (const file of files(dashboard)) {
      if (file.includes("basic-chat")) continue;
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(/className="([^"]*)"/g)) {
        const cls = m[1].split(/\s+/);
        if (cls.includes("mx-auto") && cls.some((c) => /^max-w-(xl|[2-7]xl)$/.test(c)) && !cls.includes("fixed")) {
          offenders.push(`${path.relative(root, file)}: ${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("page workbenches fill the frame instead of capping their own width", () => {
    const css = fs.readFileSync(path.join(root, "src/app/globals.css"), "utf8");
    for (const selector of [".usage-workbench", ".setup-workbench"]) {
      const block = css.slice(css.indexOf(`${selector}`), css.indexOf("}", css.indexOf(`${selector}`)));
      expect(block, selector).not.toMatch(/width:\s*min\(/);
      expect(block, selector).not.toMatch(/margin-inline:\s*auto/);
    }
  });

  it("reserves the scrollbar gutter so centering does not shift between pages", () => {
    const layout = fs.readFileSync(path.join(root, "src/shared/components/layouts/DashboardLayout.js"), "utf8");
    expect(layout).toContain("[scrollbar-gutter:stable]");
  });
});
