import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";

import i18nConfig from "../../config/i18n.json" with { type: "json" };
import {
  DEFAULT_LOCALE,
  LANGUAGES,
  LOCALES,
  LOCALE_ALIASES,
  LOCALE_COOKIE,
  RTL_LOCALES,
} from "../../src/i18n/config.ts";

test("i18n config adapter reflects the JSON source of truth", () => {
  assert.deepEqual(
    LOCALES,
    i18nConfig.locales.map((locale) => locale.code)
  );
  assert.equal(DEFAULT_LOCALE, i18nConfig.default);
  assert.deepEqual(RTL_LOCALES, i18nConfig.rtl);
  assert.equal(LOCALE_COOKIE, "NEXT_LOCALE");
});

test("i18n language metadata preserves native and English names", () => {
  assert.equal(LANGUAGES.length, i18nConfig.locales.length);

  const english = LANGUAGES.find((language) => language.code === "en");
  const englishConfig = i18nConfig.locales.find((language) => language.code === "en");
  assert.deepEqual(english, {
    code: "en",
    label: englishConfig?.label,
    name: englishConfig?.name,
    native: englishConfig?.native,
    english: englishConfig?.english,
    flag: englishConfig?.flag,
  });
});

test("locale aliases are lower-case, unique and never collide with a locale code", () => {
  const codes = new Set(LOCALES.map((code) => code.toLowerCase()));
  const seen = new Set<string>();
  for (const [code, aliases] of Object.entries(LOCALE_ALIASES)) {
    assert.ok(codes.has(code.toLowerCase()), `${code} is not a configured locale`);
    for (const alias of aliases) {
      assert.equal(alias, alias.toLowerCase(), `${alias} must be lower-case`);
      assert.ok(!codes.has(alias), `${alias} collides with a locale code`);
      assert.ok(!seen.has(alias), `${alias} is declared for two locales`);
      seen.add(alias);
    }
  }
});

test("the product ships English catalogs only", () => {
  assert.deepEqual(LOCALES, ["en"]);
  assert.deepEqual(RTL_LOCALES, []);
  assert.deepEqual(LOCALE_ALIASES, {});
  for (const directory of ["src/i18n/messages", "bin/cli/locales"]) {
    assert.deepEqual(
      readdirSync(path.resolve(directory)).filter((name) => name.endsWith(".json")),
      ["en.json"]
    );
  }
  assert.equal(existsSync(path.resolve("docs/i18n")), false);
});
