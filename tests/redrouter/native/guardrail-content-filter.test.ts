import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Scratch install: the registry's other guardrails read settings while they run.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-content-filter-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-content-filter";

const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { GuardrailRegistry, guardrailRegistry } = await import(
  "../../../src/lib/guardrails/registry.ts"
);
const { ContentFilterGuardrail } = await import("../../../src/lib/guardrails/contentFilter.ts");
const rules = await import("../../../src/lib/guardrails/contentFilterRules.ts");
const { updateSettingsSchema } = await import("../../../src/shared/validation/settingsSchemas.ts");
const settingsRoute = await import("../../../src/app/api/settings/route.ts");
const { getSettings } = await import("../../../src/lib/db/settings.ts");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

type Rule = import("../../../src/lib/guardrails/contentFilterRules.ts").ContentFilterRule;

const rule = (overrides: Partial<Rule> & Pick<Rule, "id" | "pattern">): Rule => ({
  label: "",
  type: "keyword",
  scope: "both",
  action: "block",
  enabled: true,
  ...overrides,
});

function filterRegistry() {
  const registry = new GuardrailRegistry();
  registry.register(new ContentFilterGuardrail());
  return registry;
}

const plan = (list: Rule[], enabled = true) => ({
  entries: {},
  contentFilter: { enabled, rules: list },
});

const chat = (text: string) => ({ messages: [{ role: "user", content: text }] });

test("a keyword matches case-insensitively as a substring", async () => {
  const out = await filterRegistry().runPreCallHooks(chat("Please send the CONFIDENTIAL memo"), {
    guardrailPlan: plan([rule({ id: "k1", pattern: "confidential" })]),
  });
  assert.equal(out.blocked, true);
  assert.equal(out.guardrail, "content-filter");
});

test("whole-word keywords ignore substrings and accept real words next to punctuation", async () => {
  const registry = filterRegistry();
  const guard = plan([rule({ id: "w1", pattern: "cat", wholeWord: true })]);
  assert.equal(
    (await registry.runPreCallHooks(chat("we should concatenate"), { guardrailPlan: guard })).blocked,
    false
  );
  assert.equal(
    (await registry.runPreCallHooks(chat("The Cat, sat."), { guardrailPlan: guard })).blocked,
    true
  );
  assert.equal(
    (await registry.runPreCallHooks(chat("the cat_food bin"), { guardrailPlan: guard })).blocked,
    false,
    "an underscore continues the word"
  );
});

test("a regex rule matches, case-insensitively", async () => {
  const registry = filterRegistry();
  const guard = plan([rule({ id: "r1", type: "regex", pattern: "project-[a-z]{3}\\d+" })]);
  assert.equal(
    (await registry.runPreCallHooks(chat("about PROJECT-abc42 today"), { guardrailPlan: guard }))
      .blocked,
    true
  );
  assert.equal(
    (await registry.runPreCallHooks(chat("about project-ab42"), { guardrailPlan: guard })).blocked,
    false
  );
});

test("a block returns a fixed message and never the rule text or the matched text", async () => {
  const out = await filterRegistry().runPreCallHooks(chat("tell me about zebra-launch-codes"), {
    guardrailPlan: plan([
      rule({ id: "r-secret", label: "launch codes", pattern: "zebra-launch-codes" }),
    ]),
  });
  assert.equal(out.blocked, true);
  assert.equal(out.message, rules.CONTENT_FILTER_REQUEST_BLOCK_MESSAGE);
  // What leaves the guardrail (message + per-guardrail results), not the caller's own payload.
  const serialised = JSON.stringify({ message: out.message, results: out.results });
  assert.ok(!serialised.includes("zebra"), "neither the pattern nor the match is reported");
  assert.ok(!serialised.includes("launch codes"), "the rule label is not reported");
  assert.ok(serialised.includes("r-secret"), "only the rule id is");
});

test("a flag rule lets the request through and records an event", async () => {
  const events: unknown[] = [];
  const out = await filterRegistry().runPreCallHooks(chat("this mentions pineapple"), {
    guardrailPlan: plan([rule({ id: "f1", pattern: "pineapple", action: "flag" })]),
    recordEvent: (event) => events.push(event),
  });
  assert.equal(out.blocked, false);
  assert.deepEqual(out.payload, chat("this mentions pineapple"));
  assert.deepEqual(events, [
    { guardrailId: "content-filter", stage: "request", action: "flag", ruleId: "f1" },
  ]);
});

test("a block records a block event that names the rule id only", async () => {
  const events: Array<Record<string, unknown>> = [];
  await filterRegistry().runPreCallHooks(chat("banana"), {
    guardrailPlan: plan([rule({ id: "b1", pattern: "banana" })]),
    recordEvent: (event) => events.push(event),
  });
  assert.deepEqual(events, [
    { guardrailId: "content-filter", stage: "request", action: "block", ruleId: "b1" },
  ]);
});

test("a monitoring sink that throws never breaks the request", async () => {
  const out = await filterRegistry().runPreCallHooks(chat("banana"), {
    guardrailPlan: plan([rule({ id: "b1", pattern: "banana" }), rule({ id: "f", pattern: "x", action: "flag" })]),
    recordEvent: () => {
      throw new Error("sink down");
    },
  });
  assert.equal(out.blocked, true);
});

test("disabled rules are ignored, and the whole filter does nothing when off or absent", async () => {
  const registry = filterRegistry();
  const off = plan([rule({ id: "d", pattern: "banana", enabled: false })]);
  assert.equal((await registry.runPreCallHooks(chat("banana"), { guardrailPlan: off })).blocked, false);

  const masterOff = plan([rule({ id: "d", pattern: "banana" })], false);
  const skipped = await registry.runPreCallHooks(chat("banana"), { guardrailPlan: masterOff });
  assert.equal(skipped.blocked, false);
  assert.equal(skipped.results.length, 0, "an inactive filter leaves no trace in the results");

  const none = await registry.runPreCallHooks(chat("banana"), {});
  assert.equal(none.results.length, 0);
});

test("scope decides which side a rule sees", async () => {
  const registry = filterRegistry();
  const requestOnly = plan([rule({ id: "s1", pattern: "banana", scope: "request" })]);
  const responseOnly = plan([rule({ id: "s2", pattern: "banana", scope: "response" })]);
  const reply = { choices: [{ message: { role: "assistant", content: "I like banana" } }] };

  assert.equal((await registry.runPreCallHooks(chat("banana"), { guardrailPlan: requestOnly })).blocked, true);
  assert.equal((await registry.runPostCallHooks(reply, { guardrailPlan: requestOnly })).blocked, false);
  assert.equal((await registry.runPreCallHooks(chat("banana"), { guardrailPlan: responseOnly })).blocked, false);

  const blocked = await registry.runPostCallHooks(reply, { guardrailPlan: responseOnly });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.message, rules.CONTENT_FILTER_RESPONSE_BLOCK_MESSAGE);
});

test("a caller cannot opt out of the content filter with a header or body field", async () => {
  const out = await filterRegistry().runPreCallHooks(chat("banana"), {
    guardrailPlan: plan([rule({ id: "b1", pattern: "banana" })]),
    disabledGuardrails: ["content-filter"],
  });
  assert.equal(out.blocked, true);
});

test("the filter runs inside the default registry once a plan activates it", async () => {
  const blocked = await guardrailRegistry.runPreCallHooks(chat("say banana"), {
    guardrailPlan: plan([rule({ id: "b1", pattern: "banana" })]),
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.guardrail, "content-filter");
});

test("text extraction reads message text across API shapes and skips ids, roles and blobs", () => {
  const texts = rules.extractScanTexts({
    model: "gpt-secret-model",
    messages: [
      { role: "user", content: "plain" },
      { role: "user", content: [{ type: "text", text: "part one" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    ],
    contents: [{ parts: [{ text: "gemini text" }] }],
    input: "responses text",
    output: [{ content: [{ type: "output_text", text: "responses out" }] }],
    system: [{ type: "text", text: "claude system" }],
  });
  for (const expected of ["plain", "part one", "gemini text", "responses text", "responses out", "claude system"]) {
    assert.ok(texts.includes(expected), `missing ${expected}`);
  }
  assert.ok(!texts.some((text) => text.includes("gpt-secret-model") || text.includes("base64")));
  assert.deepEqual(rules.extractScanTexts("bare string"), ["bare string"]);
});

test("a regex sees text past the first window", () => {
  const compiled = rules.compileContentFilterRules([
    rule({ id: "deep", type: "regex", pattern: "needle\\d+" }),
  ]);
  const text = `${"x".repeat(20_000)} needle42 ${"y".repeat(20_000)}`;
  assert.equal(rules.findMatchingRules([text], compiled, "request").length, 1);
});

test("catastrophic and unsupported regexes are refused, ordinary ones are kept", () => {
  const refused = [
    "(a+)+$",
    "(a*)*b",
    "(a|aa)+$",
    "(a|b)*c",
    "(.*)*x",
    "(x+x+)+y",
    "(a+){2,9}",
    "(?=lookahead)foo",
    "(?<!behind)foo",
    "(?<name>x)",
    "(a)\\1",
    "a{1,500}",
    ".*foo.*bar",
    "a+b+c+d+e+f+",
    "[unclosed",
    "(unbalanced",
    "*start",
    "x".repeat(rules.CONTENT_FILTER_MAX_PATTERN_LENGTH + 1),
    "",
  ];
  for (const pattern of refused) {
    assert.notEqual(rules.validateRegexPattern(pattern), null, `should refuse ${pattern.slice(0, 30)}`);
  }
  const accepted = ["\\bfoo\\d{2,4}\\b", "secret\\s*[:=]\\s*\\S+", "(?:red|green|blue) fish", "colou?r", "(ab)?c+", "\\d{3}-\\d{4}"];
  for (const pattern of accepted) {
    assert.equal(rules.validateRegexPattern(pattern), null, `should accept ${pattern}`);
  }
  // A refused pattern that slipped into storage is dropped at compile time, never run.
  const compiled = rules.compileContentFilterRules([
    rule({ id: "bad", type: "regex", pattern: "(a+)+$" }),
    rule({ id: "ok", pattern: "fine" }),
  ]);
  assert.deepEqual(compiled.map((entry) => entry.id), ["ok"]);
});

// --- Settings validation ----------------------------------------------------------------------

const filterSetting = (ruleList: unknown[], enabled = true) => ({
  guardrailContentFilter: { enabled, rules: ruleList },
});

test("the content-filter setting is validated: rule shape, regex safety, limits", () => {
  const good = rule({ id: "ok-1", pattern: "banana" });
  assert.equal(updateSettingsSchema.safeParse(filterSetting([good])).success, true);
  assert.equal(updateSettingsSchema.safeParse(filterSetting([])).success, true);

  const invalid: unknown[] = [
    [{ ...good, type: "glob" }],
    [{ ...good, scope: "stream" }],
    [{ ...good, action: "redact" }],
    [{ ...good, pattern: "" }],
    [{ ...good, pattern: "x".repeat(201) }],
    [{ ...good, id: "has space" }],
    [{ ...good, enabled: "yes" }],
    [{ ...good, type: "regex", pattern: "(a+)+$" }],
    [good, { ...good }],
    Array.from({ length: 101 }, (_, index) => rule({ id: `r${index}`, pattern: `w${index}` })),
  ];
  for (const rulesList of invalid) {
    assert.equal(
      updateSettingsSchema.safeParse(filterSetting(rulesList as unknown[])).success,
      false,
      JSON.stringify(rulesList).slice(0, 80)
    );
  }
  assert.equal(
    updateSettingsSchema.safeParse(
      filterSetting(Array.from({ length: 100 }, (_, index) => rule({ id: `r${index}`, pattern: `w${index}` })))
    ).success,
    true,
    "exactly 100 rules is allowed"
  );
});

const patch = (body: unknown) =>
  settingsRoute.PATCH(
    new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );

test("the settings route stores a valid content filter and answers 400 to a catastrophic pattern", async () => {
  const bad = await patch(filterSetting([rule({ id: "evil", type: "regex", pattern: "(a+)+$" })]));
  assert.equal(bad.status, 400);
  assert.ok(!JSON.stringify(await bad.json()).includes("(a+)+$"), "the pattern is not echoed");
  assert.equal((await getSettings()).guardrailContentFilter, undefined);

  const stored = [rule({ id: "kw", pattern: "banana" })];
  const ok = await patch(filterSetting(stored));
  assert.equal(ok.status, 200);
  assert.deepEqual((await getSettings()).guardrailContentFilter, {
    enabled: true,
    rules: stored,
  });
});
