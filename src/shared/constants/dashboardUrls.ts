/**
 * The dashboard's visible URLs follow the menu: `/<area>/<page>` (`/proxy/providers`,
 * `/optimize/context/settings`, ...) instead of `/dashboard/<page>`. No page moved: `next.config.mjs`
 * rewrites the area URL to the page that already exists (`/dashboard/providers`) and redirects the
 * old URL to the new one. The page files, and every hard-coded `/dashboard/...` link, keep working.
 *
 * The mapping is DERIVED from the menu model (`sidebarNav.ts`) so a page added to the menu is
 * covered without touching this file:
 *
 *   `/dashboard/<seg>[/rest]`  ->  `/<area of the entry that owns <seg>>/<seg>[/rest]`
 *
 * Refinements, all derived from the same data:
 *   - a first segment whose menu pages all belong to ONE area maps as a whole segment
 *     (`/dashboard/context` -> `/optimize/context`), so unlisted sub-pages follow their folder;
 *   - a first segment shared by several areas (`analytics`) maps page by page, and the longest
 *     prefix wins (`/dashboard/analytics/compression` is Optimize, the rest of analytics is Home);
 *   - `tools` and `system` are legacy folders that hold pages of several areas, so their name is
 *     dropped (`/dashboard/tools/agent-bridge` -> `/agents/agent-bridge`);
 *   - a page no menu entry owns (`/dashboard/onboarding`, `/dashboard/usage`) has no rule and keeps
 *     its `/dashboard` URL. `/home` stays `/home`.
 *
 * SECURITY. Everything in the authz layer is keyed on the `/dashboard` prefix, and Next runs the
 * proxy (middleware) BEFORE rewrites, so it sees the NEW url. `canonicalDashboardPath` is the one
 * translation the authz classifier applies first (`classifyRoute`), so every existing rule
 * (management auth, the public onboarding page, the loopback-only embedded-service proxy, the login
 * redirect) is evaluated on the page that is really served. It is a SUPERSET of what the Next
 * rewrite matches (case-insensitive, `//` collapsed, percent-encoded segments decoded), so no URL
 * can be served without being classified like the page it reaches. `isMalformedAreaUrl` covers the
 * rest: an area URL carrying dot segments, an encoded slash/backslash, a NUL or a broken escape is
 * refused outright rather than being interpreted.
 *
 * This module is a constants leaf: it imports nothing from server code, and `next.config.mjs` loads
 * it directly (Node's type stripping), so it uses `.ts` specifiers and erasable syntax only.
 * `sidebarNav.ts` imports it back; the table is built lazily on first use so that cycle is inert.
 */
import { SIDEBAR_NAV_SECTIONS } from "./sidebarNav.ts";

export interface DashboardUrlRule {
  /** The menu area that owns the page. */
  area: string;
  /** `/dashboard/...` prefix of the existing page. */
  oldPrefix: string;
  /** `/<area>/...` prefix shown to the operator. */
  newPrefix: string;
}

interface NavLike {
  id: string;
  entries: readonly {
    tabs: readonly { href: string; children?: readonly { href: string }[] }[];
  }[];
}

/** Legacy folders that group pages of several areas: their name is not part of the new URL. */
const NAMESPACE_SEGMENTS: ReadonlySet<string> = new Set(["tools", "system"]);

/**
 * Subtrees under `/dashboard` that must never be redirected: the reverse proxy to an embedded
 * service UI (Hard Rules #15/#17). Its HTML links point at the `/dashboard/...` prefix, and a
 * redirect on every asset would add a hop for nothing. `*` is one segment.
 */
export const DASHBOARD_REDIRECT_EXCLUSIONS: readonly (readonly string[])[] = [
  ["providers", "services", "*", "embed"],
];

const DASHBOARD_ROOT = "/dashboard";

const splitSegments = (path: string): string[] => path.split("/").filter(Boolean);

/** Derives the rules from any menu-shaped data (exported for the tests; the default is the real menu). */
export function deriveDashboardUrlRules(sections: readonly NavLike[]): DashboardUrlRule[] {
  const pages: { area: string; segs: string[] }[] = [];
  for (const section of sections) {
    for (const entry of section.entries) {
      for (const tab of entry.tabs) {
        for (const href of [tab.href, ...(tab.children ?? []).map((child) => child.href)]) {
          if (!href.startsWith(`${DASHBOARD_ROOT}/`)) continue;
          const segs = splitSegments(href.slice(DASHBOARD_ROOT.length).split(/[?#]/)[0]);
          if (segs.length > 0) pages.push({ area: section.id, segs });
        }
      }
    }
  }

  const byFirst = new Map<string, { area: string; segs: string[] }[]>();
  for (const page of pages) {
    const group = byFirst.get(page.segs[0]) ?? [];
    group.push(page);
    byFirst.set(page.segs[0], group);
  }

  const rules = new Map<string, { area: string; old: string[]; next: string[] }>();
  const add = (area: string, old: string[], next: string[]) => {
    const key = old.join("/");
    if (!rules.has(key)) rules.set(key, { area, old, next });
  };
  for (const [first, group] of byFirst) {
    const namespace = NAMESPACE_SEGMENTS.has(first);
    if (!namespace && new Set(group.map((page) => page.area)).size === 1) {
      add(group[0].area, [first], [first]);
      continue;
    }
    for (const page of group) {
      add(page.area, page.segs, namespace && page.segs.length > 1 ? page.segs.slice(1) : page.segs);
    }
  }

  // A rule that its parent rule already implies (same area, same tail) is redundant.
  const all = [...rules.values()];
  const kept = all.filter(
    (rule) =>
      !all.some(
        (parent) =>
          parent !== rule &&
          parent.area === rule.area &&
          parent.old.length < rule.old.length &&
          parent.old.every((seg, index) => seg === rule.old[index]) &&
          [...parent.next, ...rule.old.slice(parent.old.length)].join("/") === rule.next.join("/")
      )
  );

  return kept
    .map((rule) => ({
      area: rule.area,
      oldPrefix: `${DASHBOARD_ROOT}/${rule.old.join("/")}`,
      newPrefix: `/${rule.area}/${rule.next.join("/")}`,
    }))
    .sort(
      (a, b) =>
        splitSegments(b.oldPrefix).length - splitSegments(a.oldPrefix).length ||
        a.oldPrefix.localeCompare(b.oldPrefix)
    );
}

interface CompiledRule extends DashboardUrlRule {
  oldSegs: string[];
  newSegs: string[];
}

interface Compiled {
  rules: readonly DashboardUrlRule[];
  byOld: readonly CompiledRule[];
  byNew: readonly CompiledRule[];
  areas: ReadonlySet<string>;
}

let compiled: Compiled | null = null;

function table(): Compiled {
  if (compiled) return compiled;
  const rules = deriveDashboardUrlRules(SIDEBAR_NAV_SECTIONS);
  const withSegs: CompiledRule[] = rules.map((rule) => ({
    ...rule,
    oldSegs: splitSegments(rule.oldPrefix),
    newSegs: splitSegments(rule.newPrefix),
  }));
  compiled = {
    rules,
    byOld: withSegs,
    byNew: [...withSegs].sort((a, b) => b.newSegs.length - a.newSegs.length),
    areas: new Set(SIDEBAR_NAV_SECTIONS.map((section) => section.id)),
  };
  return compiled;
}

/** Every rule, longest `/dashboard` prefix first. */
export function dashboardUrlRules(): readonly DashboardUrlRule[] {
  return table().rules;
}

/** The menu areas, i.e. the first segment of every area URL (`home`, `proxy`, ...). */
export function dashboardAreaIds(): readonly string[] {
  return [...table().areas];
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** The area a URL's first segment names (case-insensitive, percent-decoded), or null. */
function areaOf(pathname: string): string | null {
  if (typeof pathname !== "string" || pathname.charCodeAt(0) !== 47) return null;
  // Leading empty segments (`//proxy`) are skipped like the `//` inside a path.
  let start = 1;
  while (pathname.charCodeAt(start) === 47) start += 1;
  const end = pathname.indexOf("/", start);
  const first = safeDecode(pathname.slice(start, end === -1 ? undefined : end));
  if (first === null) return null;
  const area = first.toLowerCase();
  return table().areas.has(area) ? area : null;
}

/** True for `/proxy`, `/PROXY/x`, `/home/...`: the URL lives in a menu area's namespace. */
export function isAreaUrl(pathname: string): boolean {
  return areaOf(pathname) !== null;
}

/**
 * True for an area URL that is not a plain path: a dot segment, an encoded or literal backslash, an
 * encoded slash inside a segment, a NUL/control character, or a broken percent escape. Such a URL is
 * never mapped: the proxy answers 400 instead of guessing which page a rewrite would serve.
 */
export function isMalformedAreaUrl(pathname: string): boolean {
  if (areaOf(pathname) === null) return false;
  if (pathname.includes("\\")) return true;
  for (const raw of pathname.split("/")) {
    const decoded = safeDecode(raw);
    if (decoded === null) return true;
    if (decoded === "." || decoded === "..") return true;
    if (decoded.includes("/") || decoded.includes("\\")) return true;
    for (let index = 0; index < decoded.length; index += 1) {
      if (decoded.charCodeAt(index) < 32 || decoded.charCodeAt(index) === 127) return true;
    }
  }
  return false;
}

/**
 * The existing `/dashboard/...` path an area URL is served from; anything else is returned as it
 * came. Matching ignores case, collapses empty segments and decodes each segment, but the tail is
 * kept exactly as sent. An area URL with no rule (`/proxy/unknown`) and a malformed one stay as they
 * are, so they fall to the classifier's default (management) instead of a lower class.
 */
export function canonicalDashboardPath(pathname: string): string {
  const area = areaOf(pathname);
  if (area === null || isMalformedAreaUrl(pathname)) return pathname;
  const raw = splitSegments(pathname);
  if (area === "home" && raw.length === 1) return "/home";
  const decoded = raw.map((segment) => (safeDecode(segment) ?? segment).toLowerCase());
  for (const rule of table().byNew) {
    if (rule.newSegs.length > decoded.length) continue;
    if (rule.newSegs.every((seg, index) => seg === decoded[index])) {
      const tail = raw.slice(rule.newSegs.length);
      return tail.length > 0 ? `${rule.oldPrefix}/${tail.join("/")}` : rule.oldPrefix;
    }
  }
  return pathname;
}

/**
 * The area URL of an existing `/dashboard/...` path (a query string or hash is kept); anything a
 * rule does not cover is returned unchanged.
 */
export function areaUrl(href: string): string {
  if (typeof href !== "string" || !href.startsWith(`${DASHBOARD_ROOT}/`)) return href;
  const cut = href.search(/[?#]/);
  const path = cut === -1 ? href : href.slice(0, cut);
  const suffix = cut === -1 ? "" : href.slice(cut);
  const segs = splitSegments(path);
  for (const rule of table().byOld) {
    if (rule.oldSegs.length > segs.length) continue;
    if (rule.oldSegs.every((seg, index) => seg === segs[index])) {
      const tail = segs.slice(rule.oldSegs.length);
      return `${rule.newPrefix}${tail.length > 0 ? `/${tail.join("/")}` : ""}${suffix}`;
    }
  }
  return href;
}

// ─── next.config.mjs generators ───────────────────────────────────────────────

export interface UrlRewrite {
  source: string;
  destination: string;
}

export interface UrlRedirect extends UrlRewrite {
  permanent: boolean;
}

/** `beforeFiles`-style rewrites: area URL -> the existing page (the tail is preserved). */
export function dashboardUrlRewrites(): UrlRewrite[] {
  return [...table().byNew].map((rule) => ({
    source: `${rule.newPrefix}/:path*`,
    destination: `${rule.oldPrefix}/:path*`,
  }));
}

const escapeSegment = (segment: string): string =>
  segment === "*" ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Redirects from each old URL to its area URL. Temporary (307) while the scheme settles; the query
 * string is preserved by Next. The embedded-service proxy subtree is left out (see
 * `DASHBOARD_REDIRECT_EXCLUSIONS`).
 */
export function dashboardUrlRedirects(): UrlRedirect[] {
  const redirects: UrlRedirect[] = [];
  for (const rule of table().byOld) {
    const excluded = DASHBOARD_REDIRECT_EXCLUSIONS.filter(
      (path) =>
        path.length > rule.oldSegs.length - 1 &&
        rule.oldSegs.slice(1).every((seg, index) => seg === path[index])
    );
    if (excluded.length === 0) {
      redirects.push({
        source: `${rule.oldPrefix}/:path*`,
        destination: `${rule.newPrefix}/:path*`,
        permanent: false,
      });
      continue;
    }
    const lookahead = excluded
      .map((path) =>
        path
          .slice(rule.oldSegs.length - 1)
          .map(escapeSegment)
          .join("/")
      )
      .map((tail) => `${tail}(?:/|$)`)
      .join("|");
    redirects.push({ source: rule.oldPrefix, destination: rule.newPrefix, permanent: false });
    redirects.push({
      source: `${rule.oldPrefix}/:path((?!${lookahead}).*)`,
      destination: `${rule.newPrefix}/:path`,
      permanent: false,
    });
  }
  return redirects;
}

/** Header source patterns for the embedded-service proxy under its area URL. */
export function dashboardEmbedSources(): string[] {
  return [areaUrl("/dashboard/providers/services/:name/embed/:path*")];
}
