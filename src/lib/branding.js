// White-label branding: one JSON file changes the visual identity (name, logo,
// favicon), the login screen and the theme. Nothing else about RedRouter
// changes. The file is <DATA_DIR>/branding.json, or the path in
// RED_ROUTER_BRANDING; Settings → Branding edits the same file.
//
// {
//   "name": "Acme AI Gateway",
//   "logo": "https://…/logo.svg" | "data:image/svg+xml;base64,…" | "logo.svg",
//   "logoDark": "…",                      // optional, used in dark mode
//   "favicon": "…",
//   "login": { "title": "…", "subtitle": "…", "background": "#0b1020" | "<image>", "footer": "…" },
//   "theme": {
//     "primary": "#2563eb",                // accent (buttons, links, focus)
//     "primaryHover": "#1d4ed8",
//     "radius": "0.5rem",
//     "fontFamily": "Inter, system-ui, sans-serif",
//     "colorScheme": "light" | "dark" | "system",
//     "light": { "--reddb-color-background": "#fff" },   // any DS/theme token
//     "dark": { "--reddb-color-background": "#0b1020" }
//   }
// }
//
// An image given as a file name is resolved next to the JSON and served by
// /api/branding/asset/<field>.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

export const DEFAULT_NAME = "RedRouter";
export const IMAGE_FIELDS = ["logo", "logoDark", "favicon", "loginBackground"];
const IMAGE_TYPES = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".gif": "image/gif" };
const MAX_TEXT = 200;
const MAX_TOKENS = 200;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
// Only custom properties of the design system and the dashboard's own palette,
// with values that cannot close the declaration or the rule.
const TOKEN_NAME = /^--(reddb|color|font|radius|shadow)-[a-z0-9-]{1,80}$/;
const SAFE_VALUE = /^[^;{}<>\\]{1,200}$/;
const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|color-mix)\([^;{}<>]{1,120}\)|[a-z]{3,20})$/i;

export const brandingFile = (env = process.env) => env.RED_ROUTER_BRANDING || path.join(DATA_DIR, "branding.json");

const text = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_TEXT) : null);

function image(value, errors, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return errors.push(`${field} must be a string`), null;
  const v = value.trim();
  // No quotes, spaces or parentheses: the URL goes into CSS url("…") and <img src>.
  if (/^https?:\/\/[^\s"'()<>\\]+$/i.test(v)) return { kind: "url", value: v };
  if (/^data:image\/(png|jpeg|webp|gif|svg\+xml|x-icon);base64,[a-z0-9+/=]+$/i.test(v)) return { kind: "data", value: v };
  if (/^[\w.-]+\.(svg|png|jpe?g|webp|ico|gif)$/i.test(v)) return { kind: "file", value: v };
  errors.push(`${field} must be an https URL, a base64 data:image URI, or a file name next to branding.json`);
  return null;
}

function tokens(map, errors, where) {
  if (map === undefined || map === null) return {};
  if (typeof map !== "object" || Array.isArray(map)) return errors.push(`${where} must be an object of CSS custom properties`), {};
  const out = {};
  for (const [name, value] of Object.entries(map).slice(0, MAX_TOKENS)) {
    if (!TOKEN_NAME.test(name)) { errors.push(`${where}: "${name}" is not an allowed token (use --reddb-*, --color-*, --font-*, --radius-*, --shadow-*)`); continue; }
    if (typeof value !== "string" || !SAFE_VALUE.test(value.trim())) { errors.push(`${where}: "${name}" has an invalid value`); continue; }
    out[name] = value.trim();
  }
  return out;
}

function color(value, errors, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !COLOR.test(value.trim())) return errors.push(`${field} must be a CSS color`), null;
  return value.trim();
}

/**
 * Validate a branding document. Unknown fields are ignored; bad fields are
 * reported and dropped, so a partly wrong file still applies what is right.
 * @returns {{ value: object, errors: string[] }}
 */
export function normalizeBranding(raw) {
  const errors = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { value: null, errors: ["branding must be a JSON object"] };
  const login = raw.login && typeof raw.login === "object" ? raw.login : {};
  const theme = raw.theme && typeof raw.theme === "object" ? raw.theme : {};
  const loginBg = typeof login.background === "string" && COLOR.test(login.background.trim()) ? login.background.trim() : null;
  const value = {
    name: text(raw.name),
    logo: image(raw.logo, errors, "logo"),
    logoDark: image(raw.logoDark, errors, "logoDark"),
    favicon: image(raw.favicon, errors, "favicon"),
    login: {
      title: text(login.title),
      subtitle: text(login.subtitle),
      footer: text(login.footer),
      backgroundColor: loginBg,
    },
    loginBackground: loginBg ? null : image(login.background, errors, "login.background"),
    theme: {
      primary: color(theme.primary, errors, "theme.primary"),
      primaryHover: color(theme.primaryHover, errors, "theme.primaryHover"),
      radius: typeof theme.radius === "string" && /^\d+(\.\d+)?(px|rem|em)$/.test(theme.radius.trim()) ? theme.radius.trim() : null,
      fontFamily: typeof theme.fontFamily === "string" && /^[\w\s,'"-]{1,200}$/.test(theme.fontFamily.trim()) ? theme.fontFamily.trim() : null,
      colorScheme: ["light", "dark", "system"].includes(theme.colorScheme) ? theme.colorScheme : null,
      light: tokens(theme.light, errors, "theme.light"),
      dark: tokens(theme.dark, errors, "theme.dark"),
    },
  };
  if (theme.radius !== undefined && !value.theme.radius) errors.push("theme.radius must be a length like 8px or 0.5rem");
  if (theme.fontFamily !== undefined && !value.theme.fontFamily) errors.push("theme.fontFamily has characters that are not allowed");
  if (theme.colorScheme !== undefined && !value.theme.colorScheme) errors.push("theme.colorScheme must be light, dark or system");
  return { value, errors };
}

let cached = { file: null, mtimeMs: -1, branding: null };

/** The active branding (null when there is none), re-read when the file changes. */
export function loadBranding(env = process.env) {
  const file = brandingFile(env);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    cached = { file, mtimeMs: -1, branding: null };
    return null;
  }
  if (cached.file === file && cached.mtimeMs === stat.mtimeMs) return cached.branding;
  let branding = null;
  try {
    const { value, errors } = normalizeBranding(JSON.parse(fs.readFileSync(file, "utf8")));
    if (errors.length) console.warn(`[Branding] ${file}: ${errors.join("; ")}`);
    branding = value;
  } catch (e) {
    console.warn(`[Branding] ${file}: ${e.message}`);
  }
  cached = { file, mtimeMs: stat.mtimeMs, branding };
  return branding;
}

export function saveBranding(raw, env = process.env) {
  const { value, errors } = normalizeBranding(raw);
  if (!value) return { errors };
  const file = brandingFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(raw, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return { errors };
}

export function removeBranding(env = process.env) {
  try { fs.unlinkSync(brandingFile(env)); } catch { /* none */ }
}

/** Where the browser loads an image field from. */
function imageUrl(img, field) {
  if (!img) return null;
  return img.kind === "file" ? `/api/branding/asset/${field}` : img.value;
}

/** The part of the branding the browser needs (names and image URLs). */
export function publicBranding(branding) {
  return {
    name: branding?.name || DEFAULT_NAME,
    custom: !!branding,
    logo: imageUrl(branding?.logo, "logo"),
    logoDark: imageUrl(branding?.logoDark, "logoDark") || imageUrl(branding?.logo, "logo"),
    favicon: imageUrl(branding?.favicon, "favicon"),
    login: {
      title: branding?.login?.title || branding?.name || DEFAULT_NAME,
      subtitle: branding?.login?.subtitle || null,
      footer: branding?.login?.footer || null,
      backgroundColor: branding?.login?.backgroundColor || null,
      backgroundImage: imageUrl(branding?.loginBackground, "loginBackground"),
    },
    colorScheme: branding?.theme?.colorScheme || null,
  };
}

/** A file-backed image: its bytes and type, or null. Only names next to the JSON. */
export function readBrandingAsset(field, env = process.env) {
  if (!IMAGE_FIELDS.includes(field)) return null;
  const branding = loadBranding(env);
  const img = field === "loginBackground" ? branding?.loginBackground : branding?.[field];
  if (img?.kind !== "file") return null;
  const file = path.join(path.dirname(brandingFile(env)), path.basename(img.value));
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_IMAGE_BYTES) return null;
    return { body: fs.readFileSync(file), type: IMAGE_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" };
  } catch {
    return null;
  }
}

/** CSS that applies the theme on top of the design system, or "" without one. */
export function brandingCss(branding) {
  const theme = branding?.theme;
  if (!theme) return "";
  const common = [];
  if (theme.primary) common.push(`--reddb-color-primary: ${theme.primary}`, `--reddb-color-brand-primary: ${theme.primary}`);
  if (theme.primaryHover || theme.primary) common.push(`--reddb-color-brand-hover: ${theme.primaryHover || `color-mix(in srgb, ${theme.primary} 85%, black)`}`);
  if (theme.radius) common.push(`--reddb-radius-md: ${theme.radius}`, `--reddb-radius-lg: calc(${theme.radius} * 1.33)`);
  if (theme.fontFamily) common.push(`--reddb-font-family-sans: ${theme.fontFamily}`);
  const decl = (list) => list.map((d) => `  ${d};`).join("\n");
  const entries = (map) => Object.entries(map || {}).map(([k, v]) => `${k}: ${v}`);
  const blocks = [];
  // After the design system's own scheme rules, and specific enough to win.
  if (common.length) blocks.push(`:root, :root[data-color-scheme] {\n${decl(common)}\n}`);
  if (Object.keys(theme.light || {}).length) blocks.push(`:root[data-color-scheme="light"] {\n${decl(entries(theme.light))}\n}`);
  if (Object.keys(theme.dark || {}).length) blocks.push(`:root[data-color-scheme="dark"], :root.dark {\n${decl(entries(theme.dark))}\n}`);
  return blocks.join("\n");
}
