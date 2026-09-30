import assert from "node:assert/strict";
import { test } from "node:test";

// Pure: no database, no network, no environment.
const catalog = await import("../../../src/lib/proxyPresets/catalog.ts");
const schema = await import("../../../src/lib/proxyPresets/schema.ts");

const SID = "abc123def456";
const SID_IPROYAL = "abc123de";

type Values = Record<string, string | boolean>;

function preset(id: string) {
  const found = catalog.getProxyPreset(id);
  assert.ok(found, `preset ${id} exists`);
  return found;
}

function params(id: string, values: Values) {
  const p = preset(id);
  return schema.buildPresetParamsSchema(p).safeParse(schema.withParamDefaults(p, values));
}

test("catalog: ids are unique, every vendor preset is unverified with docs, Tor is not a vendor", () => {
  const ids = catalog.PROXY_PRESETS.map((p) => p.id);
  assert.deepEqual(ids, ["tor", "brightdata", "oxylabs", "decodo", "iproyal"]);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of catalog.PROXY_PRESETS) {
    if (p.kind === "residential") {
      assert.equal(p.verified, false, `${p.id} must be unverified`);
      assert.match(p.docsUrl ?? "", /^https:\/\//, `${p.id} has a docs url`);
      assert.match(p.verificationNote, /not tested against a live account/i);
    }
    const names = p.params.map((param) => param.name);
    assert.equal(new Set(names).size, names.length, `${p.id} param names are unique`);
  }
});

test("catalog: the summary is descriptors only (no build function, no credential-shaped value)", () => {
  const summaries = catalog.PROXY_PRESETS.map(catalog.summarizeProxyPreset);
  const json = JSON.stringify(summaries);
  assert.ok(!json.includes("build"));
  for (const s of summaries) assert.equal("build" in s, false);
  const secretParams = summaries.flatMap((s) => s.params).filter((p) => p.type === "password");
  assert.ok(secretParams.length >= 4);
  for (const p of secretParams)
    assert.equal(p.defaultValue, undefined, "no default for a password");
});

test("tor: local SOCKS on the daemon port by default, Tor Browser port on request", () => {
  const p = preset("tor");
  const daemon = p.build({ port: "9050" });
  assert.deepEqual(daemon.proxy.type, "socks5");
  assert.equal(daemon.proxy.host, "127.0.0.1");
  assert.equal(daemon.proxy.port, 9050);
  assert.equal(daemon.proxy.username, "");
  assert.equal(daemon.proxy.password, "");
  assert.equal(daemon.sticky, false);
  assert.equal(p.build({ port: "9150" }).proxy.port, 9150);
  // Anything else falls back to the daemon port instead of producing a strange endpoint.
  assert.equal(p.build({ port: "22" }).proxy.port, 9050);
  assert.ok(p.warnings.some((w) => /does not install or run Tor/i.test(w)));
  assert.ok(p.warnings.some((w) => /block/i.test(w) && /terms of service/i.test(w)));
});

test("composition table: Bright Data username", () => {
  const base = { customer: "hl_1234", zone: "res1" };
  assert.equal(catalog.composeBrightDataUsername(base), "brd-customer-hl_1234-zone-res1");
  assert.equal(
    catalog.composeBrightDataUsername({ ...base, country: "US" }),
    "brd-customer-hl_1234-zone-res1-country-us"
  );
  assert.equal(
    catalog.composeBrightDataUsername({ ...base, sessionId: SID }),
    `brd-customer-hl_1234-zone-res1-session-${SID}`
  );
  assert.equal(
    catalog.composeBrightDataUsername({ ...base, country: "de", sessionId: SID }),
    `brd-customer-hl_1234-zone-res1-country-de-session-${SID}`
  );
  // A malformed country is dropped, never spliced into the login.
  assert.equal(
    catalog.composeBrightDataUsername({ ...base, country: "usa-x" }),
    "brd-customer-hl_1234-zone-res1"
  );
});

test("composition table: Oxylabs username", () => {
  assert.equal(catalog.composeOxylabsUsername({ user: "bob" }), "customer-bob");
  assert.equal(
    catalog.composeOxylabsUsername({ user: "bob", country: "us" }),
    "customer-bob-cc-US"
  );
  assert.equal(
    catalog.composeOxylabsUsername({ user: "bob", sessionId: SID, sessionMinutes: 10 }),
    `customer-bob-sessid-${SID}-sesstime-10`
  );
  assert.equal(
    catalog.composeOxylabsUsername({
      user: "bob",
      country: "de",
      sessionId: SID,
      sessionMinutes: 30,
    }),
    `customer-bob-cc-DE-sessid-${SID}-sesstime-30`
  );
  // Rotating ignores a stray session length.
  assert.equal(catalog.composeOxylabsUsername({ user: "bob", sessionMinutes: 30 }), "customer-bob");
});

test("composition table: Decodo username", () => {
  assert.equal(catalog.composeDecodoUsername({ user: "bob" }), "user-bob");
  assert.equal(
    catalog.composeDecodoUsername({ user: "bob", country: "US" }),
    "user-bob-country-us"
  );
  assert.equal(
    catalog.composeDecodoUsername({ user: "bob", sessionId: SID, sessionMinutes: 10 }),
    `user-bob-session-${SID}-sessionduration-10`
  );
  assert.equal(
    catalog.composeDecodoUsername({ user: "bob", country: "de", sessionId: SID }),
    `user-bob-country-de-session-${SID}`
  );
});

test("composition table: IPRoyal password suffix", () => {
  assert.equal(catalog.composeIproyalPassword({ password: "pw" }), "pw");
  assert.equal(catalog.composeIproyalPassword({ password: "pw", country: "US" }), "pw_country-us");
  assert.equal(
    catalog.composeIproyalPassword({ password: "pw", sessionId: SID_IPROYAL, lifetime: "10m" }),
    `pw_session-${SID_IPROYAL}_lifetime-10m`
  );
  assert.equal(
    catalog.composeIproyalPassword({
      password: "pw",
      country: "de",
      sessionId: SID_IPROYAL,
      lifetime: "1h",
    }),
    `pw_country-de_session-${SID_IPROYAL}_lifetime-1h`
  );
});

test("build: every vendor preset yields the documented gateway and login", () => {
  const brd = preset("brightdata").build(
    { customer: "hl_1234", zone: "res1", password: "zonepw", country: "us", stickySession: true },
    { sessionId: SID }
  );
  assert.deepEqual(brd.proxy, {
    type: "http",
    host: "brd.superproxy.io",
    port: 33335,
    username: `brd-customer-hl_1234-zone-res1-country-us-session-${SID}`,
    password: "zonepw",
    region: "us",
    notes: brd.proxy.notes,
  });
  assert.equal(brd.sticky, true);

  const oxy = preset("oxylabs").build({
    user: "bob",
    password: "pw",
    stickySession: false,
    sessionLength: "10",
  });
  assert.equal(oxy.proxy.host, "pr.oxylabs.io");
  assert.equal(oxy.proxy.port, 7777);
  assert.equal(oxy.proxy.username, "customer-bob", "rotating: no session, length ignored");
  assert.equal(oxy.sticky, false);

  const dec = preset("decodo").build(
    { user: "bob", password: "pw", stickySession: true, sessionLength: "30", country: "de" },
    { sessionId: SID }
  );
  assert.equal(dec.proxy.host, "gate.decodo.com");
  assert.equal(dec.proxy.port, 7000);
  assert.equal(dec.proxy.username, `user-bob-country-de-session-${SID}-sessionduration-30`);

  const roy = preset("iproyal").build(
    { user: "bob", password: "pw", stickySession: true, sessionLength: "30m", country: "de" },
    { sessionId: SID_IPROYAL }
  );
  assert.equal(roy.proxy.host, "geo.iproyal.com");
  assert.equal(roy.proxy.port, 12321);
  assert.equal(roy.proxy.username, "bob");
  assert.equal(roy.proxy.password, `pw_country-de_session-${SID_IPROYAL}_lifetime-30m`);
});

test("sticky sessions: a random hex id per build, rotating has none", () => {
  const values = { user: "bob", password: "pw", stickySession: true, sessionLength: "10" };
  const first = preset("oxylabs").build(values);
  const second = preset("oxylabs").build(values);
  const idOf = (username: string) => /-sessid-([^-]+)-sesstime-10$/.exec(username)?.[1];
  assert.match(idOf(first.proxy.username) ?? "", /^[0-9a-f]{12}$/);
  assert.match(idOf(second.proxy.username) ?? "", /^[0-9a-f]{12}$/);
  assert.notEqual(idOf(first.proxy.username), idOf(second.proxy.username));

  // IPRoyal ids are 8 characters.
  const royal = preset("iproyal").build({
    user: "bob",
    password: "pw",
    stickySession: true,
    sessionLength: "10m",
  });
  assert.match(royal.proxy.password, /^pw_session-[0-9a-f]{8}_lifetime-10m$/);

  const rotating = preset("brightdata").build({
    customer: "c1",
    zone: "z1",
    password: "pw",
    stickySession: false,
  });
  assert.ok(!rotating.proxy.username.includes("session"));
  assert.equal(rotating.sticky, false);

  // An injected id must look like hex, otherwise a fresh one is generated.
  const bad = preset("brightdata").build(
    { customer: "c1", zone: "z1", password: "pw", stickySession: true },
    { sessionId: "x; drop" }
  );
  assert.match(bad.proxy.username, /-session-[0-9a-f]{12}$/);
  assert.match(catalog.generateSessionId(), /^[0-9a-f]{12}$/);
});

test("params: valid input passes, defaults are filled, sticky length is optional", () => {
  const ok = params("oxylabs", { user: "bob", password: "pw" });
  assert.ok(ok.success);
  const tor = params("tor", {});
  assert.ok(tor.success, "select default fills the port");
  assert.equal(tor.data.port, "9050");
});

test("params: unknown keys, missing required and bad values are rejected", () => {
  assert.equal(params("oxylabs", { user: "bob", password: "pw", extra: "x" }).success, false);
  assert.equal(params("oxylabs", { password: "pw" }).success, false, "missing user");
  assert.equal(params("oxylabs", { user: "bob" }).success, false, "missing password");
  assert.equal(params("oxylabs", { user: "  ", password: "pw" }).success, false, "blank user");
  assert.equal(params("tor", { port: "1234" }).success, false, "port outside the options");
  assert.equal(
    params("oxylabs", { user: "bob", password: "pw", country: "usa" }).success,
    false,
    "country must be two letters"
  );
  assert.equal(
    params("oxylabs", { user: "bob", password: "pw", stickySession: "yes" }).success,
    false,
    "toggle must be a boolean"
  );
  assert.equal(
    params("oxylabs", { user: "bob", password: "pw", stickySession: true, sessionLength: "999" })
      .success,
    false,
    "session length must be one of the options"
  );
});

test("params: control characters and over-long values are rejected", () => {
  for (const bad of ["a\nb", "a\rb", "a\u0000b", "a\tb", "a\u007fb"]) {
    assert.equal(
      params("oxylabs", { user: "bob", password: bad }).success,
      false,
      JSON.stringify(bad)
    );
    assert.equal(
      params("oxylabs", { user: bad, password: "pw" }).success,
      false,
      JSON.stringify(bad)
    );
  }
  assert.equal(params("oxylabs", { user: "bob", password: "p".repeat(200) }).success, true);
  assert.equal(params("oxylabs", { user: "bob", password: "p".repeat(201) }).success, false);
  assert.equal(params("oxylabs", { user: "b".repeat(65), password: "pw" }).success, false);
  // The username segment cannot smuggle the vendor's own separators.
  assert.equal(params("oxylabs", { user: "bob-cc-US", password: "pw" }).success, false);
  assert.equal(params("brightdata", { customer: "c 1", zone: "z", password: "pw" }).success, false);
});
