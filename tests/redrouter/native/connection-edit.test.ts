import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (file: string) => readFileSync(file, "utf8");
const dir = "src/app/(dashboard)/dashboard/providers/[id]";

test("a remote RedRouter connection can always have its destination edited", async () => {
  const helpers =
    await import("../../../src/app/(dashboard)/dashboard/providers/[id]/providerPageHelpers.ts");
  // Always-on base URL field, not the opt-in "Advanced" link: the host or IP of a remote RedRouter moves.
  assert.equal(helpers.isBaseUrlConfigurableProvider("red-router"), true);
  assert.equal(helpers.isBaseUrlOverrideEligibleProvider("red-router"), false);
  assert.equal(helpers.getProviderBaseUrlDefault("red-router"), "http://127.0.0.1:25050/v1");
  assert.equal(helpers.getProviderBaseUrlPlaceholder("red-router"), "http://127.0.0.1:25050/v1");
  const hint = helpers.getProviderBaseUrlHint("red-router", (key: string) => `hint:${key}`);
  assert.equal(hint, "hint:redRouterBaseUrlHint");
  // Nothing else lost its field.
  assert.equal(helpers.isBaseUrlConfigurableProvider("modal"), true);
  assert.equal(helpers.isBaseUrlOverrideEligibleProvider("openai"), true);
});

test("the edit window is large and scrolls as one piece", () => {
  const modal = read(`${dir}/components/modals/EditConnectionModal.tsx`);
  assert.match(modal, /size="full"/);
  assert.match(modal, /\{\.\.\.TALL_MODAL_PROPS\}/);
  assert.match(modal, /TALL_MODAL_PROPS,/);
});

test("the edit form's fields carry real labels and help, not their own key names", () => {
  const messages = JSON.parse(read("src/i18n/messages/en.json"));
  const providers =
    messages.providers ??
    Object.values(messages).find((ns) => (ns as Record<string, unknown>)?.tagGroupLabel);
  const namespace = (
    providers && (providers as Record<string, unknown>).tagGroupLabel
      ? providers
      : Object.values(messages).find(
          (ns) => (ns as Record<string, string>)?.tagGroupLabel !== undefined
        )
  ) as Record<string, string>;
  const humanized = (key: string) =>
    key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
  for (const key of [
    "tagGroupLabel",
    "tagGroupPlaceholder",
    "tagGroupHint",
    "routingTagsLabel",
    "routingTagsPlaceholder",
    "routingTagsHint",
    "excludedModelsLabel",
    "excludedModelsPlaceholder",
    "excludedModelsHint",
    "redRouterBaseUrlHint",
  ]) {
    assert.ok(namespace[key], `${key} exists`);
    assert.notEqual(namespace[key], humanized(key), `${key} is still its own name`);
  }
});

test("the RedRouter provider points at the real repository and has an icon", () => {
  const gateways = read("src/shared/constants/providers/apikey/gateways.ts");
  assert.ok(gateways.includes('"https://github.com/reddb-io/red-router"'));
  const walk = (root: string, out: string[] = []) => {
    for (const name of readdirSync(root)) {
      if (["node_modules", ".next", ".build", "dist", ".git", ".claude", "_tasks"].includes(name))
        continue;
      const full = join(root, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|md|json|mjs)$/.test(name)) out.push(full);
    }
    return out;
  };
  for (const file of [...walk("src"), ...walk("docs/reference")]) {
    assert.ok(
      !read(file).includes("github.com/reddb.io/"),
      `${file} links to reddb.io instead of reddb-io`
    );
  }
  assert.equal(existsSync("public/providers/red-router.svg"), true);
  assert.match(read("public/providers/red-router.svg"), /<svg[^>]+viewBox/);
});
