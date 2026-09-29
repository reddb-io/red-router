#!/usr/bin/env node
/**
 * Moves simple Material Symbols icons to the lucide `Icon` wrapper.
 *
 *   node scripts/dev/icons-codemod.mjs <path...>           # dry run, prints a summary
 *   node scripts/dev/icons-codemod.mjs --write <path...>   # applies it
 *   node scripts/dev/icons-codemod.mjs --sample <path...>  # prints a few before/after pairs
 *
 * Only this shape is converted:
 *
 *   <span className="material-symbols-outlined text-[18px] text-text-muted">delete</span>
 *   -> <Icon icon={Trash2} size="md" color="ink-muted" />
 *
 * i.e. a literal ligature name, a literal className and no `style`. The Material name is mapped
 * through MATERIAL_TO_LUCIDE; unmapped names, dynamic names (`{icon}`), inline styles, conditional
 * classes, and glyphs whose name collides with an identifier already used in the file are left
 * alone, so the Material ratchet keeps shrinking without changing anything risky.
 *
 * Colour: the design system has no free colours, so plain `text-*` utilities become a role
 * (muted ink, foreground, primary, or a feedback role for red/green/amber) and decorative palette
 * colours are dropped to the surrounding ink. State variants (`hover:`, `group-hover:`, `dark:`)
 * stay in `className` because they do not fight the role's own class.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".claude", "_tasks"]);
const ICON_IMPORT = 'import Icon from "@/shared/components/Icon";';

const SPAN = /<span\s+className="([^"]*\bmaterial-symbols-outlined\b[^"]*)"(\s+aria-hidden(?:="true"|=\{true\})?)?\s*>\s*([a-z][a-z0-9_]*)\s*<\/span>/g;

const sizeOf = (tokens) => {
  for (const token of tokens) {
    const px = token.match(/^text-\[(\d+(?:\.\d+)?)px\]$/);
    if (px) {
      const value = Number(px[1]);
      // Large decorative glyphs (empty states, hero art) keep their own size: not converted here.
      if (value >= 28) return { skip: true };
      return { size: value <= 14 ? "sm" : value <= 19 ? "md" : "lg", used: token };
    }
    if (/^text-\[length:[^\]]+\]$/.test(token)) return { size: "lg", used: token };
    if (token === "text-xs" || token === "text-sm") return { size: "sm", used: token };
    if (token === "text-base" || token === "text-lg") return { size: "md", used: token };
    if (/^text-(3xl|4xl|5xl|6xl)$/.test(token)) return { skip: true };
    if (/^text-(xl|2xl)$/.test(token)) return { size: "lg", used: token };
  }
  return { size: "lg", used: null };
};

const TEXT_SIZE = /^text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|\[\d+(?:\.\d+)?px\]|\[length:[^\]]+\])$/;
const STATE_VARIANT = /^(?:[a-z-]+:)+/;

/** A role for a plain text colour utility, "drop" for decorative colours, null when not a colour. */
function colourRole(token) {
  if (TEXT_SIZE.test(token)) return null;
  const base = token.replace(/\/\d+$/, "");
  if (/^text-(text-muted|ink-muted|muted|gray-\d+|slate-\d+|zinc-\d+|neutral-\d+|stone-\d+)$/.test(base)) return "ink-muted";
  if (/^text-(text-main|text-text|foreground|ink|black|white)$/.test(base)) return "foreground";
  if (base === "text-text") return "foreground";
  if (base === "text-primary" || base === "text-accent") return "primary";
  if (/^text-(red|rose)-\d+$/.test(base) || base === "text-danger") return "feedback-danger-foreground";
  if (/^text-(green|emerald|lime)-\d+$/.test(base)) return "feedback-success-foreground";
  if (/^text-(amber|yellow|orange)-\d+$/.test(base)) return "feedback-warning-foreground";
  if (/^text-(blue|sky|cyan|indigo|violet|purple|pink|fuchsia|teal|current|inherit)(-\d+)?$/.test(base)) return "drop";
  if (/^text-\[#[0-9a-fA-F]{3,8}\]$/.test(base)) return "drop";
  if (/^text-\[var\(--[^)]*\)\]$/.test(base)) {
    if (/muted/.test(base)) return "ink-muted";
    if (/primary/.test(base)) return "primary";
    return "drop";
  }
  if (/^text-(sidebar|bg|surface)/.test(base)) return "drop";
  return null;
}

export function convertClassName(className) {
  const tokens = className.split(/\s+/).filter(Boolean);
  const sized = sizeOf(tokens.filter((t) => !STATE_VARIANT.test(t)));
  if (sized.skip) return null;
  const { size, used } = sized;
  let color = null;
  const keep = [];
  for (const token of tokens) {
    if (token === "material-symbols-outlined" || token === "fill-1" || token === used) continue;
    if (STATE_VARIANT.test(token)) {
      keep.push(token);
      continue;
    }
    const role = colourRole(token);
    if (role === "drop") continue;
    if (role) {
      color = color ?? role;
      continue;
    }
    if (TEXT_SIZE.test(token)) continue;
    keep.push(token);
  }
  return { size, color: color ?? "current", className: keep.join(" ") };
}

export function convertSource(source, mapping, filePath = "") {
  if (!source.includes("material-symbols-outlined")) return { text: source, count: 0, glyphs: [] };
  // Names used by the file itself: a glyph that would shadow one is not converted.
  const stripped = source.replace(SPAN, "");
  const used = new Set();
  const glyphs = new Set();
  let count = 0;
  const text = source.replace(SPAN, (whole, className, aria, name) => {
    const glyph = mapping[name];
    if (!glyph) return whole;
    if (new RegExp(`\\b${glyph}\\b`).test(stripped)) return whole;
    const converted = convertClassName(className);
    if (!converted) return whole;
    glyphs.add(glyph);
    used.add(glyph);
    count++;
    const parts = [`icon={${glyph}}`, `size="${converted.size}"`, `color="${converted.color}"`];
    if (converted.className) parts.push(`className="${converted.className}"`);
    return `<Icon ${parts.join(" ")} />`;
  });
  if (count === 0) return { text: source, count: 0, glyphs: [] };
  if (/\bIcon\b/.test(stripped) && !stripped.includes(ICON_IMPORT)) {
    return { text: source, count: 0, glyphs: [], skipped: `${filePath}: "Icon" already means something else` };
  }
  return { text: addImports(text, [...glyphs].sort()), count, glyphs: [...glyphs] };
}

function addImports(text, glyphs) {
  const lucide = text.match(/^import \{([^}]*)\} from "lucide-react";\n/m);
  let next = text;
  if (lucide) {
    const existing = lucide[1].split(",").map((s) => s.trim()).filter(Boolean);
    const merged = [...new Set([...existing, ...glyphs])].sort();
    next = next.replace(lucide[0], `import { ${merged.join(", ")} } from "lucide-react";\n`);
  }
  const lines = [];
  if (!lucide) lines.push(`import { ${glyphs.join(", ")} } from "lucide-react";`);
  if (!next.includes(ICON_IMPORT)) lines.push(ICON_IMPORT);
  if (lines.length === 0) return next;
  const firstImport = next.search(/^import /m);
  if (firstImport === -1) {
    const directive = next.match(/^(?:"use (?:client|server)";\s*\n)/);
    const at = directive ? directive[0].length : 0;
    return `${next.slice(0, at)}${directive ? "\n" : ""}${lines.join("\n")}\n${next.slice(at)}`;
  }
  return `${next.slice(0, firstImport)}${lines.join("\n")}\n${next.slice(firstImport)}`;
}

function* walk(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    yield target;
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    yield* walk(path.join(target, entry.name));
  }
}

const isSkipped = (file) =>
  !/\.(tsx|jsx)$/.test(file) ||
  /\.test\.[tj]sx?$/.test(file) ||
  /(^|\/)(__tests__|tests)\//.test(file) ||
  file.endsWith("src/shared/components/Icon.tsx");

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const sample = args.includes("--sample");
  const roots = args.filter((arg) => !arg.startsWith("--"));
  const { MATERIAL_TO_LUCIDE } = await import(
    pathToFileURL(path.resolve("src/shared/icons/materialToLucide.ts")).href
  );
  let files = 0;
  let converted = 0;
  let remaining = 0;
  let shown = 0;
  for (const root of roots) {
    for (const file of walk(root)) {
      if (isSkipped(file)) continue;
      const source = fs.readFileSync(file, "utf8");
      const result = convertSource(source, MATERIAL_TO_LUCIDE, file);
      if (result.skipped) console.error(`skip ${result.skipped}`);
      if (result.count === 0) continue;
      files++;
      converted += result.count;
      remaining += (result.text.match(/material-symbols-outlined/g) ?? []).length;
      if (sample && shown < 6) {
        shown++;
        const before = source.match(SPAN)?.[0];
        console.log(`# ${file}\n- ${before}\n+ ${result.text.match(/<Icon [^>]*\/>/)?.[0]}`);
      }
      if (write) fs.writeFileSync(file, result.text);
    }
  }
  console.log(`${write ? "converted" : "would convert"} ${converted} icons in ${files} files`);
}
