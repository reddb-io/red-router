import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../../../", import.meta.url).pathname;
const pageDir = join(root, "src/app/(dashboard)/dashboard/usage-sinks");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}
const files = sources(pageDir);
const en = JSON.parse(readFileSync(join(root, "src/i18n/messages/en.json"), "utf8")) as {
  usageSinks: Record<string, string>;
  sidebar: Record<string, string>;
};

test("every string the page asks for exists in the English catalogue", () => {
  const used = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)) {
      used.add(match[1]);
    }
  }
  assert.ok(used.size > 40, "the page is rendered from catalogue strings");
  const missing = [...used].filter((key) => typeof en.usageSinks[key] !== "string");
  assert.deepEqual(missing, []);
});

test("the page renders through the design system: no raw palette colours, no gradients", () => {
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.equal(
      /\b(?:bg|text|border|ring|from|to|via)-(?:red|green|blue|amber|yellow|orange|emerald|sky|indigo|violet|purple|pink|rose|teal|cyan|lime|slate|gray|zinc|neutral|stone)-\d{2,3}\b/.test(
        source
      ),
      false,
      `${file} uses a raw Tailwind palette colour`
    );
    assert.equal(/gradient/i.test(source), false, `${file} uses a gradient`);
    assert.equal(/#[0-9a-fA-F]{6}\b/.test(source), false, `${file} hard-codes a colour`);
  }
  const shared = readFileSync(join(pageDir, "components/SinkCard.tsx"), "utf8");
  for (const primitive of ["Badge", "Button", "Card", "Toggle"]) {
    assert.match(shared, new RegExp(`\\b${primitive}\\b`));
  }
  const form = readFileSync(join(pageDir, "components/SinkFormModal.tsx"), "utf8");
  for (const primitive of ["Input", "Select", "Button", "Modal"]) {
    assert.match(form, new RegExp(`\\b${primitive}\\b`));
  }
});

test("Usage Sinks is in the sidebar, under Integrations", () => {
  const sections = readFileSync(
    join(root, "src/shared/constants/sidebarVisibility/sections.ts"),
    "utf8"
  );
  const integrations = sections.slice(sections.indexOf("const INTEGRATIONS_GROUP"));
  assert.match(integrations.slice(0, integrations.indexOf("const PROXY_ITEM")), /"usage-sinks"/);
  assert.match(sections, /href: "\/observe\/usage-sinks"/);
  assert.equal(en.sidebar.usageSinks, "Usage Sinks");
});

test("the page talks only to endpoints that exist", () => {
  // Resolve each fetched path against the App Router folders: a `${...}` segment is a dynamic one.
  const routeExists = (path: string) => {
    let dir = join(root, "src/app");
    for (const segment of path.split("/").filter(Boolean)) {
      const entries = readdirSync(dir);
      const next = segment.startsWith("${")
        ? entries.find((entry) => entry.startsWith("["))
        : entries.find((entry) => entry === segment);
      if (!next) return false;
      dir = join(dir, next);
    }
    return readdirSync(dir).includes("route.ts");
  };
  const fetched = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(/fetch\(\s*[`"](\/api\/[^`"?]*)/g)) {
      fetched.add(match[1]);
    }
  }
  assert.ok(fetched.size >= 6);
  const missing = [...fetched].filter((path) => !routeExists(path));
  assert.deepEqual(missing, []);
});
