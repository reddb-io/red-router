import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveDataDir } from "@/lib/dataPaths";

// White-label branding: one JSON file changes the visual identity (name, logo,
// favicon), the login screen and the theme. Nothing else about the app changes.
// The file is <DATA_DIR>/branding.json, or the path in OMNIROUTE_BRANDING.
//
// {
//   "name": "Acme AI Gateway",
//   "logo": "https://…/logo.svg" | "data:image/svg+xml;base64,…" | "logo.svg",
//   "logoDark": "…",
//   "favicon": "…",
//   "login": { "title": "…", "subtitle": "…", "footer": "…", "background": "#0b1020" | "<image>" },
//   "theme": {
//     "primary": "#e54d5e",
//     "primaryHover": "#c93d4e",
//     "radius": "0.5rem",
//     "fontFamily": "Inter, system-ui, sans-serif",
//     "colorScheme": "light" | "dark" | "system",
//     "light": { "--color-bg": "#fff" },
//     "dark": { "--color-bg": "#0b1020" }
//   }
// }
//
// An image given as a file name is resolved next to the JSON and served by
// /api/branding/asset/<field>.

export const DEFAULT_BRAND_NAME = "RedRouter";
export const DEFAULT_BRAND_DESCRIPTION = "AI Gateway for Multi-Provider LLMs";

export const IMAGE_FIELDS = ["logo", "logoDark", "favicon", "loginBackground"] as const;
export type BrandingImageField = (typeof IMAGE_FIELDS)[number];

const IMAGE_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".gif": "image/gif",
};

const MAX_TEXT = 200;
const MAX_TOKENS = 200;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// Only custom properties of the app's design tokens, with values that cannot
// close the declaration or the rule.
const TOKEN_NAME = /^--(color|font|radius|shadow|grad)-[a-z0-9-]{1,80}$/;
const SAFE_VALUE = /^[^;{}<>\\]{1,200}$/;
const COLOR =
  /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|color-mix)\([^;{}<>]{1,120}\)|[a-z]{3,20})$/i;
const IMAGE_URL = /^https?:\/\/[^\s"'()<>\\]+$/i;
const DATA_URI = /^data:image\/(png|jpeg|webp|gif|svg\+xml|x-icon);base64,[a-z0-9+/=]+$/i;
const FILE_NAME = /^[\w.-]+\.(svg|png|jpe?g|webp|ico|gif)$/i;
const LENGTH = /^\d+(\.\d+)?(px|rem|em)$/;

export type BrandingImage = { kind: "url" | "data" | "file"; value: string };

export type BrandingTheme = {
  primary: string | null;
  primaryHover: string | null;
  radius: string | null;
  fontFamily: string | null;
  colorScheme: string | null;
  light: Record<string, string>;
  dark: Record<string, string>;
};

export type BrandingConfig = {
  name: string | null;
  logo: BrandingImage | null;
  logoDark: BrandingImage | null;
  favicon: BrandingImage | null;
  login: {
    title: string | null;
    subtitle: string | null;
    footer: string | null;
    backgroundColor: string | null;
  };
  loginBackground: BrandingImage | null;
  theme: BrandingTheme;
};

export type PublicBranding = {
  name: string;
  custom: boolean;
  logo: string | null;
  logoDark: string | null;
  favicon: string | null;
  login: {
    title: string;
    subtitle: string | null;
    footer: string | null;
    backgroundColor: string | null;
    backgroundImage: string | null;
  };
  colorScheme: string | null;
  theme: { primary: string | null; primaryHover: string | null };
};

const textSchema = z.string().trim().min(1).max(MAX_TEXT);
const colorSchema = z.string().trim().regex(COLOR);
const lengthSchema = z.string().trim().regex(LENGTH);
const fontFamilySchema = z
  .string()
  .trim()
  .regex(/^[\w\s,'"-]{1,200}$/);
const colorSchemeSchema = z.enum(["light", "dark", "system"]);
const tokenNameSchema = z.string().regex(TOKEN_NAME);
const tokenValueSchema = z.string().trim().regex(SAFE_VALUE);

function imageField(value: unknown, errors: string[], field: string): BrandingImage | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    errors.push(`${field} must be a string`);
    return null;
  }
  const v = value.trim();
  // No quotes, spaces or parentheses: the value goes into CSS url("…") and <img src>.
  if (IMAGE_URL.test(v)) return { kind: "url", value: v };
  if (DATA_URI.test(v)) return { kind: "data", value: v };
  if (FILE_NAME.test(v)) return { kind: "file", value: v };
  errors.push(
    `${field} must be an https URL, a base64 data:image URI, or a file name next to branding.json`
  );
  return null;
}

function tokens(map: unknown, errors: string[], where: string): Record<string, string> {
  if (map === undefined || map === null) return {};
  if (typeof map !== "object" || Array.isArray(map)) {
    errors.push(`${where} must be an object of CSS custom properties`);
    return {};
  }
  const out: Record<string, string> = {};
  const entries = Object.entries(map as Record<string, unknown>).slice(0, MAX_TOKENS);
  for (const [name, value] of entries) {
    const parsedName = tokenNameSchema.safeParse(name);
    if (!parsedName.success) {
      errors.push(
        `${where}: "${name}" is not an allowed token (use --color-*, --font-*, --radius-*, --shadow-*, --grad-*)`
      );
      continue;
    }
    const parsedValue = tokenValueSchema.safeParse(value);
    if (!parsedValue.success) {
      errors.push(`${where}: "${name}" has an invalid value`);
      continue;
    }
    out[parsedName.data] = parsedValue.data;
  }
  return out;
}

function optional<T>(
  schema: z.ZodType<T>,
  value: unknown,
  errors: string[],
  field: string
): T | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    errors.push(`${field}: ${parsed.error.issues[0]?.message ?? "invalid value"}`);
    return null;
  }
  return parsed.data;
}

/** login.background: a CSS color, or an image (URL / data URI / file next to the JSON). */
function loginBackgroundField(
  raw: unknown,
  errors: string[]
): { backgroundColor: string | null; backgroundImage: BrandingImage | null } {
  if (raw === undefined || raw === null || raw === "") {
    return { backgroundColor: null, backgroundImage: null };
  }
  if (typeof raw === "string" && COLOR.test(raw.trim())) {
    return { backgroundColor: raw.trim(), backgroundImage: null };
  }
  return { backgroundColor: null, backgroundImage: imageField(raw, errors, "login.background") };
}

export function normalizeBranding(raw: unknown): {
  value: BrandingConfig | null;
  errors: string[];
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { value: null, errors: ["branding must be a JSON object"] };
  }
  const doc = raw as Record<string, unknown>;
  const login = doc.login !== null && typeof doc.login === "object" ? doc.login : {};
  const theme = doc.theme !== null && typeof doc.theme === "object" ? doc.theme : {};
  const errors: string[] = [];

  const loginRaw = login as Record<string, unknown>;
  const themeRaw = theme as Record<string, unknown>;

  const background = loginBackgroundField(loginRaw.background, errors);
  const value: BrandingConfig = {
    name: optional(textSchema, doc.name, errors, "name"),
    logo: imageField(doc.logo, errors, "logo"),
    logoDark: imageField(doc.logoDark, errors, "logoDark"),
    favicon: imageField(doc.favicon, errors, "favicon"),
    login: {
      title: optional(textSchema, loginRaw.title, errors, "login.title"),
      subtitle: optional(textSchema, loginRaw.subtitle, errors, "login.subtitle"),
      footer: optional(textSchema, loginRaw.footer, errors, "login.footer"),
      backgroundColor: background.backgroundColor,
    },
    loginBackground: background.backgroundImage,
    theme: {
      primary: optional(colorSchema, themeRaw.primary, errors, "theme.primary"),
      primaryHover: optional(colorSchema, themeRaw.primaryHover, errors, "theme.primaryHover"),
      radius: optional(lengthSchema, themeRaw.radius, errors, "theme.radius"),
      fontFamily: optional(fontFamilySchema, themeRaw.fontFamily, errors, "theme.fontFamily"),
      colorScheme: optional(colorSchemeSchema, themeRaw.colorScheme, errors, "theme.colorScheme"),
      light: tokens(themeRaw.light, errors, "theme.light"),
      dark: tokens(themeRaw.dark, errors, "theme.dark"),
    },
  };
  return { value, errors };
}

export function brandingFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMNIROUTE_BRANDING || path.join(resolveDataDir(), "branding.json");
}

let cached = { file: "", mtimeMs: -1, branding: null as BrandingConfig | null };

/** The active branding (null when there is none), re-read when the file changes. */
export function loadBranding(env: NodeJS.ProcessEnv = process.env): BrandingConfig | null {
  const file = brandingFile(env);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cached = { file, mtimeMs: -1, branding: null };
    return null;
  }
  if (cached.file === file && cached.mtimeMs === stat.mtimeMs) return cached.branding;
  let branding: BrandingConfig | null = null;
  try {
    const { value, errors } = normalizeBranding(JSON.parse(fs.readFileSync(file, "utf8")));
    if (errors.length) console.warn(`[Branding] ${file}: ${errors.join("; ")}`);
    branding = value;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Branding] ${file}: ${message}`);
  }
  cached = { file, mtimeMs: stat.mtimeMs, branding };
  return branding;
}

export function saveBranding(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env
): {
  errors: string[];
} {
  const { value, errors } = normalizeBranding(raw);
  if (!value) return { errors };
  const file = brandingFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(raw, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return { errors };
}

export function removeBranding(env: NodeJS.ProcessEnv = process.env): void {
  try {
    fs.unlinkSync(brandingFile(env));
  } catch {
    // No branding file — nothing to remove.
  }
}

function imageUrl(img: BrandingImage | null, field: BrandingImageField): string | null {
  if (!img) return null;
  return img.kind === "file" ? `/api/branding/asset/${field}` : img.value;
}

/** The part of the branding the browser needs (names and image URLs). */
export function publicBranding(branding: BrandingConfig | null): PublicBranding {
  return {
    name: branding?.name || DEFAULT_BRAND_NAME,
    custom: !!branding,
    logo: imageUrl(branding?.logo ?? null, "logo"),
    logoDark:
      imageUrl(branding?.logoDark ?? null, "logoDark") ?? imageUrl(branding?.logo ?? null, "logo"),
    favicon: imageUrl(branding?.favicon ?? null, "favicon"),
    login: {
      title: branding?.login.title || branding?.name || DEFAULT_BRAND_NAME,
      subtitle: branding?.login.subtitle ?? null,
      footer: branding?.login.footer ?? null,
      backgroundColor: branding?.login.backgroundColor ?? null,
      backgroundImage: imageUrl(branding?.loginBackground ?? null, "loginBackground"),
    },
    colorScheme: branding?.theme.colorScheme ?? null,
    theme: {
      primary: branding?.theme.primary ?? null,
      primaryHover: branding?.theme.primaryHover ?? null,
    },
  };
}

/** A file-backed image: its bytes and type, or null. Only names next to the JSON. */
export function readBrandingAsset(
  field: string,
  env: NodeJS.ProcessEnv = process.env
): { body: Buffer; type: string } | null {
  if (!(IMAGE_FIELDS as readonly string[]).includes(field)) return null;
  const branding = loadBranding(env);
  const img =
    field === "loginBackground"
      ? (branding?.loginBackground ?? null)
      : (branding?.[field as "logo" | "logoDark" | "favicon"] ?? null);
  if (!img || img.kind !== "file") return null;
  const file = path.join(path.dirname(brandingFile(env)), path.basename(img.value));
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_IMAGE_BYTES) return null;
    return {
      body: fs.readFileSync(file),
      type: IMAGE_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
    };
  } catch {
    return null;
  }
}

/** CSS that applies the theme on top of the design tokens, or "" without one. */
export function brandingCss(branding: BrandingConfig | null): string {
  const theme = branding?.theme;
  if (!theme) return "";
  const common: string[] = [];
  if (theme.primary) {
    common.push(`--color-primary: ${theme.primary}`);
    common.push(
      `--color-primary-hover: ${theme.primaryHover || `color-mix(in srgb, ${theme.primary} 86%, black)`}`
    );
  } else if (theme.primaryHover) {
    common.push(`--color-primary-hover: ${theme.primaryHover}`);
  }
  if (theme.radius) common.push(`--radius: ${theme.radius}`);
  if (theme.fontFamily) common.push(`--font-sans: ${theme.fontFamily}`);
  const decl = (list: string[]): string => list.map((d) => `  ${d};`).join("\n");
  const entries = (map: Record<string, string>): string[] =>
    Object.entries(map).map(([k, v]) => `${k}: ${v}`);
  const blocks: string[] = [];
  if (common.length) blocks.push(`:root {\n${decl(common)}\n}`);
  if (Object.keys(theme.light).length) blocks.push(`:root {\n${decl(entries(theme.light))}\n}`);
  if (Object.keys(theme.dark).length) blocks.push(`.dark {\n${decl(entries(theme.dark))}\n}`);
  return blocks.join("\n");
}
