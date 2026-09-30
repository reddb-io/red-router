/**
 * Egress proxy presets: one-click recipes for the outbound-proxy registry.
 *
 * A preset turns a handful of operator inputs (customer id, zone, country, sticky session...) into
 * the registry fields of ONE proxy (type, host, port, username, password). Pure and server-free:
 * no database, no network, no secrets. The only side input is randomness for the sticky session id,
 * and callers can inject it.
 *
 * Nothing here is verified against a live account. Vendor gateway hosts and username grammars are
 * taken from each vendor's public documentation as understood when this was written; every vendor
 * preset is `verified: false` and carries the `docsUrl` to check it against. The generated proxy
 * is an ordinary registry row, so the operator can edit it afterwards.
 */

export type PresetParamType = "text" | "password" | "select" | "toggle";
export type PresetParamValue = string | boolean;
export type PresetValues = Record<string, PresetParamValue>;

export interface PresetParamOption {
  value: string;
  label: string;
}

export interface PresetParamDescriptor {
  name: string;
  label: string;
  type: PresetParamType;
  required: boolean;
  help: string;
  placeholder?: string;
  /** select only */
  options?: PresetParamOption[];
  /** Initial value the form starts with (and the value used when an optional param is omitted). */
  defaultValue?: PresetParamValue;
  /** text only: allowed characters, as a regular expression source anchored with ^...$. */
  pattern?: string;
  /** Shown when the pattern does not match. */
  patternHint?: string;
  /** Only meaningful while this toggle param is on (UI hides the field otherwise). */
  dependsOn?: string;
}

export type PresetKind = "tor" | "residential";
export type PresetProxyType = "socks5" | "http" | "https";

/** Registry fields a preset produces. The proxy name is supplied by the operator. */
export interface PresetProxyFields {
  type: PresetProxyType;
  host: string;
  port: number;
  username: string;
  password: string;
  notes: string;
  region: string | null;
}

export interface PresetBuildResult {
  proxy: PresetProxyFields;
  /** True when a sticky session id was generated for this proxy. */
  sticky: boolean;
}

export interface PresetBuildOptions {
  /** Injected session id (tests). Default: random hex from Web Crypto. */
  sessionId?: string;
}

export interface ProxyPreset {
  id: string;
  label: string;
  kind: PresetKind;
  description: string;
  defaultName: string;
  /** false for every vendor preset: not confirmed against a live account. */
  verified: boolean;
  /** Why it is unverified, or a short factual note. Shown in the UI. */
  verificationNote: string;
  docsUrl: string | null;
  /** Warnings the UI must show before the operator adds it. */
  warnings: string[];
  params: PresetParamDescriptor[];
  build(values: PresetValues, options?: PresetBuildOptions): PresetBuildResult;
}

// --- pure composition helpers -------------------------------------------------------------------

/** Lower-case hex string of `bytes` random bytes (2 characters each). Web Crypto: works anywhere. */
export function generateSessionId(bytes = 6): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  let out = "";
  for (const byte of buffer) out += byte.toString(16).padStart(2, "0");
  return out;
}

const SESSION_ID_PATTERN = /^[0-9a-f]{4,32}$/;

/** Country codes are two letters; anything else is treated as "no country". */
export function normalizeCountry(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  return /^[a-z]{2}$/.test(trimmed) ? trimmed : "";
}

function str(values: PresetValues, name: string): string {
  const value = values[name];
  return typeof value === "string" ? value.trim() : "";
}

function flag(values: PresetValues, name: string): boolean {
  return values[name] === true;
}

function sessionIdFor(options: PresetBuildOptions | undefined, bytes: number): string {
  const injected = options?.sessionId;
  if (typeof injected === "string" && SESSION_ID_PATTERN.test(injected)) return injected;
  return generateSessionId(bytes);
}

export interface BrightDataInput {
  customer: string;
  zone: string;
  country?: string;
  sessionId?: string;
}

/** `brd-customer-<id>-zone-<zone>[-country-xx][-session-<sid>]` */
export function composeBrightDataUsername(input: BrightDataInput): string {
  const country = normalizeCountry(input.country);
  return (
    `brd-customer-${input.customer}-zone-${input.zone}` +
    (country ? `-country-${country}` : "") +
    (input.sessionId ? `-session-${input.sessionId}` : "")
  );
}

export interface OxylabsInput {
  user: string;
  country?: string;
  sessionId?: string;
  sessionMinutes?: number;
}

/** `customer-<user>[-cc-XX][-sessid-<sid>-sesstime-<min>]` (country code upper-case). */
export function composeOxylabsUsername(input: OxylabsInput): string {
  const country = normalizeCountry(input.country).toUpperCase();
  return (
    `customer-${input.user}` +
    (country ? `-cc-${country}` : "") +
    (input.sessionId
      ? `-sessid-${input.sessionId}` +
        (input.sessionMinutes ? `-sesstime-${input.sessionMinutes}` : "")
      : "")
  );
}

export interface DecodoInput {
  user: string;
  country?: string;
  sessionId?: string;
  sessionMinutes?: number;
}

/** `user-<user>[-country-xx][-session-<sid>[-sessionduration-<min>]]` */
export function composeDecodoUsername(input: DecodoInput): string {
  const country = normalizeCountry(input.country);
  return (
    `user-${input.user}` +
    (country ? `-country-${country}` : "") +
    (input.sessionId
      ? `-session-${input.sessionId}` +
        (input.sessionMinutes ? `-sessionduration-${input.sessionMinutes}` : "")
      : "")
  );
}

export interface IproyalInput {
  password: string;
  country?: string;
  sessionId?: string;
  /** Lifetime token as IPRoyal writes it: `30s`, `10m`, `1h`. */
  lifetime?: string;
}

/** IPRoyal carries the targeting in the PASSWORD: `<password>[_country-xx][_session-<sid>_lifetime-<t>]` */
export function composeIproyalPassword(input: IproyalInput): string {
  const country = normalizeCountry(input.country);
  return (
    input.password +
    (country ? `_country-${country}` : "") +
    (input.sessionId
      ? `_session-${input.sessionId}` + (input.lifetime ? `_lifetime-${input.lifetime}` : "")
      : "")
  );
}

// --- shared descriptors -------------------------------------------------------------------------

/** Segment allowed inside a composed username: no separators the vendor grammar could misread. */
const USERNAME_SEGMENT_PATTERN = "^[A-Za-z0-9_.]{1,64}$";
const USERNAME_SEGMENT_HINT = "Letters, digits, underscore and dot only (no dashes or spaces).";

const COUNTRY_PARAM: PresetParamDescriptor = {
  name: "country",
  label: "Country (optional)",
  type: "text",
  required: false,
  placeholder: "us",
  pattern: "^[A-Za-z]{2}$",
  patternHint: "Two-letter country code, for example us or de.",
  help: "Two-letter country code to pin the exit country. Leave empty for any country.",
};

const STICKY_PARAM: PresetParamDescriptor = {
  name: "stickySession",
  label: "Sticky session",
  type: "toggle",
  required: false,
  defaultValue: false,
  help:
    "On: a random session id is generated once, when you add the proxy, and baked into the login. " +
    "Every connection assigned to this proxy then keeps the same exit IP for the vendor's session " +
    "lifetime. Off: rotating, the vendor may hand out a new exit IP on each request.",
};

function sessionLengthParam(
  options: PresetParamOption[],
  defaultValue: string
): PresetParamDescriptor {
  return {
    name: "sessionLength",
    label: "Session length",
    type: "select",
    required: false,
    defaultValue,
    options,
    dependsOn: "stickySession",
    help: "How long the vendor keeps the same exit IP for the session id. Only used with a sticky session.",
  };
}

const MINUTE_OPTIONS: PresetParamOption[] = [
  { value: "1", label: "1 minute" },
  { value: "5", label: "5 minutes" },
  { value: "10", label: "10 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "60 minutes" },
];

const IPROYAL_LIFETIME_OPTIONS: PresetParamOption[] = [
  { value: "1m", label: "1 minute" },
  { value: "10m", label: "10 minutes" },
  { value: "30m", label: "30 minutes" },
  { value: "1h", label: "1 hour" },
];

function passwordParam(label: string, help: string): PresetParamDescriptor {
  return { name: "password", label, type: "password", required: true, help };
}

function textParam(
  name: string,
  label: string,
  help: string,
  placeholder: string
): PresetParamDescriptor {
  return {
    name,
    label,
    type: "text",
    required: true,
    help,
    placeholder,
    pattern: USERNAME_SEGMENT_PATTERN,
    patternHint: USERNAME_SEGMENT_HINT,
  };
}

const VENDOR_NOTE_SUFFIX =
  " Gateway host, port and login format come from the vendor's public documentation and were not " +
  "tested against a live account; edit the generated proxy if your plan differs.";

const RESIDENTIAL_WARNING =
  "Residential proxies are billed by the vendor, usually per gigabyte. Check the vendor's terms " +
  "before sending AI provider traffic through them.";

function minutes(values: PresetValues): number {
  const parsed = Number.parseInt(str(values, "sessionLength"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// --- presets ------------------------------------------------------------------------------------

export const TOR_PORT_DAEMON = 9050;
export const TOR_PORT_BROWSER = 9150;

const torPreset: ProxyPreset = {
  id: "tor",
  label: "Tor (local SOCKS)",
  kind: "tor",
  description:
    "Points a SOCKS5 proxy at a Tor client you already run on this machine (127.0.0.1:9050).",
  defaultName: "Tor (local)",
  verified: true,
  verificationNote:
    "A plain local SOCKS5 endpoint: RedRouter only records the address and does not run Tor.",
  docsUrl: "https://support.torproject.org/tbb/tbb-9/",
  warnings: [
    "RedRouter does not install or run Tor. Start it yourself (for example the tor daemon) before " +
      "assigning this proxy.",
    "Tor exit nodes are public and many AI providers block them, so requests often fail with 403 " +
      "or captchas. A provider's terms of service may also forbid using Tor. Use it only where you " +
      "are allowed to, and expect it to be slow.",
  ],
  params: [
    {
      name: "port",
      label: "Tor SOCKS port",
      type: "select",
      required: true,
      defaultValue: String(TOR_PORT_DAEMON),
      options: [
        { value: String(TOR_PORT_DAEMON), label: "9050 - Tor daemon (tor)" },
        { value: String(TOR_PORT_BROWSER), label: "9150 - Tor Browser" },
      ],
      help: "9050 is the port of the standalone tor daemon. 9150 is used by Tor Browser while it is open.",
    },
  ],
  build(values) {
    const port = Number.parseInt(str(values, "port"), 10);
    return {
      sticky: false,
      proxy: {
        type: "socks5",
        host: "127.0.0.1",
        port: port === TOR_PORT_BROWSER ? TOR_PORT_BROWSER : TOR_PORT_DAEMON,
        username: "",
        password: "",
        region: null,
        notes: "Preset: Tor local SOCKS. RedRouter does not run Tor; start it yourself.",
      },
    };
  },
};

const brightDataPreset: ProxyPreset = {
  id: "brightdata",
  label: "Bright Data",
  kind: "residential",
  description: "Residential gateway at brd.superproxy.io:33335 with zone-based login.",
  defaultName: "Bright Data residential",
  verified: false,
  verificationNote: `Not tested against a live account.${VENDOR_NOTE_SUFFIX}`,
  docsUrl: "https://docs.brightdata.com/proxy-networks/residential/introduction",
  warnings: [RESIDENTIAL_WARNING],
  params: [
    textParam(
      "customer",
      "Customer ID",
      "Your Bright Data customer id, without the brd-customer- prefix.",
      "hl_1234abcd"
    ),
    textParam(
      "zone",
      "Zone name",
      "The residential zone to use, as named in the Bright Data control panel.",
      "residential_proxy1"
    ),
    passwordParam("Zone password", "The password of that zone. Stored as the proxy password."),
    COUNTRY_PARAM,
    STICKY_PARAM,
  ],
  build(values, options) {
    const sticky = flag(values, "stickySession");
    const username = composeBrightDataUsername({
      customer: str(values, "customer"),
      zone: str(values, "zone"),
      country: str(values, "country"),
      sessionId: sticky ? sessionIdFor(options, 6) : undefined,
    });
    return {
      sticky,
      proxy: {
        type: "http",
        host: "brd.superproxy.io",
        port: 33335,
        username,
        password: str(values, "password"),
        region: normalizeCountry(str(values, "country")) || null,
        notes: "Preset: Bright Data residential (unverified login format).",
      },
    };
  },
};

const oxylabsPreset: ProxyPreset = {
  id: "oxylabs",
  label: "Oxylabs",
  kind: "residential",
  description: "Residential gateway at pr.oxylabs.io:7777 with customer-based login.",
  defaultName: "Oxylabs residential",
  verified: false,
  verificationNote: `Not tested against a live account.${VENDOR_NOTE_SUFFIX}`,
  docsUrl: "https://developers.oxylabs.io/proxies/residential-proxies",
  warnings: [RESIDENTIAL_WARNING],
  params: [
    textParam(
      "user",
      "Username",
      "Your Oxylabs proxy username, without the customer- prefix.",
      "myuser"
    ),
    passwordParam("Password", "Your Oxylabs proxy password."),
    COUNTRY_PARAM,
    STICKY_PARAM,
    sessionLengthParam(MINUTE_OPTIONS, "10"),
  ],
  build(values, options) {
    const sticky = flag(values, "stickySession");
    const username = composeOxylabsUsername({
      user: str(values, "user"),
      country: str(values, "country"),
      sessionId: sticky ? sessionIdFor(options, 6) : undefined,
      sessionMinutes: minutes(values),
    });
    return {
      sticky,
      proxy: {
        type: "http",
        host: "pr.oxylabs.io",
        port: 7777,
        username,
        password: str(values, "password"),
        region: normalizeCountry(str(values, "country")) || null,
        notes: "Preset: Oxylabs residential (unverified login format).",
      },
    };
  },
};

const decodoPreset: ProxyPreset = {
  id: "decodo",
  label: "Smartproxy / Decodo",
  kind: "residential",
  description: "Residential gateway at gate.decodo.com:7000 (Smartproxy, now Decodo).",
  defaultName: "Decodo residential",
  verified: false,
  verificationNote:
    "Assumption: the gateway host is gate.decodo.com (the former gate.smartproxy.com) and the " +
    `session-length suffix is -sessionduration-<minutes>. Not tested against a live account.${VENDOR_NOTE_SUFFIX}`,
  docsUrl: "https://help.decodo.com/docs/residential-proxy-quick-start",
  warnings: [RESIDENTIAL_WARNING],
  params: [
    textParam("user", "Username", "Your proxy user, without the user- prefix.", "sp1234abcd"),
    passwordParam("Password", "Your proxy user password."),
    COUNTRY_PARAM,
    STICKY_PARAM,
    sessionLengthParam(MINUTE_OPTIONS, "10"),
  ],
  build(values, options) {
    const sticky = flag(values, "stickySession");
    const username = composeDecodoUsername({
      user: str(values, "user"),
      country: str(values, "country"),
      sessionId: sticky ? sessionIdFor(options, 6) : undefined,
      sessionMinutes: minutes(values),
    });
    return {
      sticky,
      proxy: {
        type: "http",
        host: "gate.decodo.com",
        port: 7000,
        username,
        password: str(values, "password"),
        region: normalizeCountry(str(values, "country")) || null,
        notes: "Preset: Smartproxy / Decodo residential (unverified login format).",
      },
    };
  },
};

const iproyalPreset: ProxyPreset = {
  id: "iproyal",
  label: "IPRoyal",
  kind: "residential",
  description: "Residential gateway at geo.iproyal.com:12321; targeting goes in the password.",
  defaultName: "IPRoyal residential",
  verified: false,
  verificationNote:
    "Assumption: targeting is appended to the password as _country-xx_session-<id>_lifetime-<t> " +
    `and the session id is 8 characters. Not tested against a live account.${VENDOR_NOTE_SUFFIX}`,
  docsUrl: "https://docs.iproyal.com/proxies/residential/proxy",
  warnings: [RESIDENTIAL_WARNING],
  params: [
    textParam("user", "Username", "Your IPRoyal proxy username.", "myuser"),
    passwordParam(
      "Password",
      "Your IPRoyal proxy password. Country and session are appended to it, so the stored password differs from the one you type."
    ),
    COUNTRY_PARAM,
    STICKY_PARAM,
    sessionLengthParam(IPROYAL_LIFETIME_OPTIONS, "10m"),
  ],
  build(values, options) {
    const sticky = flag(values, "stickySession");
    const password = composeIproyalPassword({
      password: str(values, "password"),
      country: str(values, "country"),
      // IPRoyal session ids are 8 characters: 4 random bytes.
      sessionId: sticky ? sessionIdFor(options, 4) : undefined,
      lifetime: str(values, "sessionLength") || undefined,
    });
    return {
      sticky,
      proxy: {
        type: "http",
        host: "geo.iproyal.com",
        port: 12321,
        username: str(values, "user"),
        password,
        region: normalizeCountry(str(values, "country")) || null,
        notes: "Preset: IPRoyal residential (unverified login format).",
      },
    };
  },
};

export const PROXY_PRESETS: readonly ProxyPreset[] = [
  torPreset,
  brightDataPreset,
  oxylabsPreset,
  decodoPreset,
  iproyalPreset,
];

export function getProxyPreset(id: unknown): ProxyPreset | null {
  if (typeof id !== "string") return null;
  return PROXY_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** What the API and dashboard see: descriptors only, no `build`, never a credential. */
export type ProxyPresetSummary = Omit<ProxyPreset, "build">;

export function summarizeProxyPreset(preset: ProxyPreset): ProxyPresetSummary {
  return {
    id: preset.id,
    label: preset.label,
    kind: preset.kind,
    description: preset.description,
    defaultName: preset.defaultName,
    verified: preset.verified,
    verificationNote: preset.verificationNote,
    docsUrl: preset.docsUrl,
    warnings: [...preset.warnings],
    params: preset.params.map((param) => ({ ...param })),
  };
}
