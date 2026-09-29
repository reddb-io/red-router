import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { displayInstanceName } from "../../../src/shared/constants/productBranding.ts";

const root = process.cwd();
const read = (name: string): string => fs.readFileSync(path.join(root, name), "utf8");

test("legacy default is displayed as RedRouter, while custom branding survives", () => {
  assert.equal(displayInstanceName(undefined), "RedRouter");
  assert.equal(displayInstanceName("OmniRoute"), "RedRouter");
  assert.equal(displayInstanceName("My AI Gateway"), "My AI Gateway");
});

test("HTML entry points and loading copy belong to RedRouter", () => {
  assert.match(read("src/app/layout.tsx"), /title: brand\.custom \? brand\.name : `\$\{instanceName\}/);
  assert.match(read("src/app/manifest.ts"), /short_name: "RedRouter"/);
  assert.match(read("src/app/loading.tsx"), /Loading RedRouter/);
  assert.match(read("src/app/api/docs/route.ts"), /<title>RedRouter API Reference<\/title>/);
  assert.match(read("bin/cli/commands/login.mjs"), /<title>RedRouter<\/title>/);
  assert.match(read("src/i18n/messages/en.json"), /"startingOmniRoute": "Starting RedRouter\.\.\."/);
});

test("tray icon is a branded PNG, not the inherited spinner", () => {
  const png = fs.readFileSync(path.join(root, "bin/cli/tray/icon.png"));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 64);
  assert.match(read("bin/cli/tray/icon.svg"), /#ff2056/i);
});

test("English UI and CLI copy no longer names the inherited product", () => {
  const stray = (name: string): string[] => {
    const walk = (value: unknown, found: string[]): string[] => {
      if (typeof value === "string") {
        if (/(?<![-@./\w])Omni(Route|Proxy)(?![-\w/])/.test(value)) found.push(value);
      } else if (value && typeof value === "object") {
        for (const child of Object.values(value)) walk(child, found);
      }
      return found;
    };
    return walk(JSON.parse(read(name)), []);
  };
  assert.deepEqual(stray("src/i18n/messages/en.json"), []);
  assert.deepEqual(stray("bin/cli/locales/en.json"), []);
});
