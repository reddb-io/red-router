import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SIDEBAR_SECTIONS,
  getSectionItems,
} from "../../../src/shared/constants/sidebarVisibility.ts";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const messages = JSON.parse(read("src/i18n/messages/en.json")) as {
  setup: Record<string, string>;
  sidebar: Record<string, string>;
};
const files = {
  workbench: read("src/app/(dashboard)/dashboard/SetupWorkbench.tsx"),
  recommended: read("src/shared/components/RecommendedSetup.tsx"),
  page: read("src/app/(dashboard)/dashboard/setup/page.tsx"),
};

test("Setup sits at the top of the sidebar, visible by default, under the Home section", () => {
  const home = SIDEBAR_SECTIONS.find((section) => section.id === "home");
  assert.ok(home);
  const items = getSectionItems(home);
  assert.deepEqual(
    items.map((item) => item.id),
    ["home", "setup"]
  );
  const setup = items[1];
  assert.equal(setup.href, "/dashboard/setup");
  assert.equal(messages.sidebar[setup.i18nKey], "Setup");
  assert.ok(messages.sidebar[setup.subtitleKey ?? ""]);
});

test("the setup page renders the workbench", () => {
  assert.match(files.page, /import SetupWorkbench from "\.\.\/SetupWorkbench"/);
  assert.match(files.page, /<SetupWorkbench \/>/);
});

test("every translation key the setup UI reads exists in the setup namespace", () => {
  const used = new Set<string>();
  for (const source of [files.workbench, files.recommended]) {
    for (const match of source.matchAll(/\bt(?:\.rich)?\(\s*"([A-Za-z0-9]+)"/g)) used.add(match[1]);
    for (const match of source.matchAll(
      /(?:key|labelKey): "([A-Za-z0-9]+)"|"(role[A-Z][a-z]+|action[A-Z][a-z]+)"/g
    )) {
      used.add(match[1] ?? match[2]);
    }
  }
  assert.ok(used.size > 30, "the keys are actually extracted");
  const missing = [...used].filter((key) => !(key in messages.setup));
  assert.deepEqual(missing, []);
});

test("the setup UI is English and uses the design system roles, not raw palette colours or gradients", () => {
  for (const source of [files.workbench, files.recommended]) {
    assert.equal(
      /\b(?:red|green|blue|amber|yellow|orange|gray|slate|zinc|emerald)-\d{2,3}\b/.test(source),
      false
    );
    assert.equal(/gradient/i.test(source), false);
  }
  assert.match(files.workbench, /@\/shared\/components/);
});

test("the workbench keeps Friday's flow: providers, keys, route validation and recommended combos", () => {
  assert.ok(files.workbench.includes('"/api/providers"'));
  assert.ok(files.workbench.includes('"/api/keys"'));
  assert.ok(files.workbench.includes('"/api/setup/validate"'));
  assert.ok(files.recommended.includes('"/api/combos/recommended"'));
  assert.equal(messages.setup.stepOf, "Step {step} of 5");
  assert.equal(messages.setup.configTitle, "Configure your client");
});
