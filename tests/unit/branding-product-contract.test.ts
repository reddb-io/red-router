import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  brandingCss,
  brandingFile,
  loadBranding,
  normalizeBranding,
  publicBranding,
  saveBranding,
} from "../../src/lib/branding/branding.ts";

test("RedRouter branding path takes precedence while retaining the upstream fallback", () => {
  assert.equal(
    brandingFile({
      RED_ROUTER_BRANDING: "/redrouter/brand.json",
      OMNIROUTE_BRANDING: "/upstream/brand.json",
    }),
    "/redrouter/brand.json"
  );
  assert.equal(
    brandingFile({ RED_ROUTER_BRANDING: "", OMNIROUTE_BRANDING: "/upstream/brand.json" }),
    "/upstream/brand.json"
  );
});

test("RedRouter branding persists and reaches the browser through its original contract", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "redrouter-brand-contract-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = {
    RED_ROUTER_BRANDING: path.join(directory, "redrouter.json"),
    OMNIROUTE_BRANDING: path.join(directory, "upstream.json"),
  };
  const doc = {
    name: "RedRouter Workspace",
    logo: "logo.svg",
    login: { title: "Workspace sign-in" },
    theme: {
      light: { "--reddb-color-background": "#ffffff" },
      dark: { "--reddb-color-background": "#0d1117", "--color-primary": "#ff2056" },
    },
  };

  assert.deepEqual(saveBranding(doc, env).errors, []);
  assert.equal(existsSync(env.RED_ROUTER_BRANDING), true);
  assert.equal(existsSync(env.OMNIROUTE_BRANDING), false);
  const loaded = loadBranding(env);
  assert.ok(loaded);
  assert.equal(publicBranding(loaded).name, doc.name);
  assert.equal(publicBranding(loaded).login.title, doc.login.title);
  assert.equal(publicBranding(loaded).logo, "/api/branding/asset/logo");
  assert.match(brandingCss(loaded), /:root \{\n  --reddb-color-background: #ffffff;/);
  assert.match(brandingCss(loaded), /\.dark \{\n  --reddb-color-background: #0d1117;/);
  assert.match(brandingCss(loaded), /--color-primary: #ff2056;/);
});

test("restored RedDB tokens still reject CSS injection and unrelated properties", () => {
  const { value, errors } = normalizeBranding({
    theme: {
      light: {
        "--reddb-color-background": "red; } body { display: none",
        "--reddb-color-foreground": "</style><script>alert(1)</script>",
        "--unrelated-property": "red",
        "--reddb-color-accent": "#ff2056",
        "--grad-primary": "linear-gradient(red, blue)",
      },
    },
  });

  assert.ok(value);
  assert.equal(errors.length, 3);
  assert.deepEqual(value.theme.light, {
    "--reddb-color-accent": "#ff2056",
    "--grad-primary": "linear-gradient(red, blue)",
  });
  assert.doesNotMatch(brandingCss(value), /<script>|display: none|unrelated-property/);
});
