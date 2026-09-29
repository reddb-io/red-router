import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sortProviderEntriesByName } from "../../../src/app/(dashboard)/dashboard/providers/providerPageUtils.ts";

const entry = (providerId: string, name: string) => ({
  providerId,
  provider: { name },
  stats: {},
  displayAuthType: "apikey",
  toggleAuthType: "apikey",
});

test("provider grids are alphabetical, with nobody promoted", () => {
  const sorted = sortProviderEntriesByName([
    entry("moonshot", "Moonshot AI"),
    entry("cheaperinference", "Cheaper Inference"),
    entry("kimi-coding", "Kimi Code CLI"),
    entry("openai", "OpenAI"),
    entry("anthropic", "anthropic"),
    entry("gpt10", "GPT 10"),
    entry("gpt4", "GPT 4"),
  ] as never);
  assert.deepEqual(
    sorted.map((item) => item.providerId),
    ["anthropic", "cheaperinference", "gpt4", "gpt10", "kimi-coding", "moonshot", "openai"]
  );
});

test("the dashboard has no supporter or partner highlight", () => {
  const card = readFileSync(
    "src/app/(dashboard)/dashboard/providers/components/ProviderCard.tsx",
    "utf8"
  );
  for (const word of ["Supporter", "Open Source Friend", "Founding Friend", "isKimiPartner"]) {
    assert.equal(card.includes(word), false, word);
  }
  const catalog = ["oauth.ts", "apikey/regional.ts", "apikey/gateways.ts"]
    .map((file) => readFileSync(`src/shared/constants/providers/${file}`, "utf8"))
    .join("\n");
  assert.equal(/aff=omniroute|utm_source=omniroute/.test(catalog), false, "affiliate links");
});
