import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MATERIAL_TO_LUCIDE } from "@/shared/icons/materialToLucide.js";

// react-dom lives in the root install; skip the markup checks when it is absent.
const server = await import("react-dom/server").catch(() => null);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function listJs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listJs(path);
    return /\.(js|jsx|mjs)$/.test(entry.name) ? [path] : [];
  });
}

const SOURCES = [...listJs(join(ROOT, "src")), ...listJs(join(ROOT, "open-sse/providers/registry"))].map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, "utf8"),
}));

const NAME = "[a-z][a-z0-9_]*";
// Literal branches of an expression: `a ? "x" : "y"`, `v || "x"`, or a bare "x".
const BRANCH_LITERAL = new RegExp(`(?:^|[?:]|\\|\\|)\\s*"(${NAME})"`, "g");

function iconNamesIn(text) {
  const names = new Set();
  const add = (name) => names.add(name);
  for (const [, n] of text.matchAll(new RegExp(`\\bicon(?:Right)?="(${NAME})"`, "g"))) add(n);
  for (const [, n] of text.matchAll(new RegExp(`\\bicon:\\s*"(${NAME})"`, "g"))) add(n);
  for (const [, n] of text.matchAll(new RegExp(`<Icon\\b[^>]*?\\bname="(${NAME})"`, "g"))) add(n);
  const dynamic = [
    ...text.matchAll(/<Icon\b[^>]*?\bname=\{([^{}]*)\}/g),
    ...text.matchAll(/\bicon(?:Right)?=\{([^{}]*)\}/g),
    ...text.matchAll(/\bicon:\s*([^,\n}]*\?[^,\n}]*)/g),
  ];
  for (const [, expr] of dynamic) for (const [, n] of expr.trim().matchAll(BRANCH_LITERAL)) add(n);
  return names;
}

describe("dashboard icons (lucide behind the Icon wrapper)", () => {
  it("has no Material Symbols usage left in src", () => {
    const offenders = SOURCES.filter(({ path, text }) => path.startsWith("src") && text.includes("material-symbols"));
    expect(offenders.map(({ path }) => path)).toEqual([]);
  });

  it("maps every icon name the dashboard renders to a lucide glyph", () => {
    const used = new Map();
    for (const { path, text } of SOURCES) {
      for (const name of iconNamesIn(text)) if (!used.has(name)) used.set(name, path);
    }
    expect(used.size).toBeGreaterThan(100);
    const unmapped = [...used].filter(([name]) => !MATERIAL_TO_LUCIDE[name]).map(([name, path]) => `${name} (${path})`);
    expect(unmapped).toEqual([]);
  });

  it("maps only to real lucide components", () => {
    for (const [name, glyph] of Object.entries(MATERIAL_TO_LUCIDE)) {
      expect(glyph, name).toBeTruthy();
      expect(["function", "object"], name).toContain(typeof glyph);
    }
  });

  describe("Icon wrapper markup", () => {
    const it_ = server ? it : it.skip;
    const render = async (props) => {
      const { createElement } = await import("react");
      const { default: Icon } = await import("@/shared/components/Icon.js");
      return server.renderToStaticMarkup(createElement(Icon, props));
    };

    it_("is decorative by default", async () => {
      const html = await render({ name: "settings" });
      expect(html).toMatch(/^<svg\b/);
      expect(html).toContain('aria-hidden="true"');
      expect(html).not.toContain("role=");
      expect(html).toContain('width="1em"');
      expect(html).toContain('stroke="currentColor"');
    });

    it_("is a labelled image when given a label", async () => {
      const html = await render({ name: "content_copy", label: "Copy", size: "lg" });
      expect(html).toContain('role="img"');
      expect(html).toContain('aria-label="Copy"');
      expect(html).not.toContain("aria-hidden");
      expect(html).toContain('width="20"');
    });

    it_("renders a neutral fallback for an unknown name instead of throwing", async () => {
      const html = await render({ name: "definitely_not_an_icon", size: 12 });
      expect(html).toMatch(/^<svg\b/);
      expect(html).toContain('width="12"');
    });
  });
});
