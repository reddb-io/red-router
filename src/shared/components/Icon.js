import { createElement } from "react";
import { Circle } from "lucide-react";
import { MATERIAL_TO_LUCIDE } from "@/shared/icons/materialToLucide";

// The only seam between the dashboard and lucide (DS ADR 0015). Glyphs are
// addressed by their Material Symbols name so string `icon` props keep working.
// Written with createElement instead of JSX so the node-only test runner can
// import it.

const SIZES = { sm: 16, md: "1em", lg: 20 };
const warned = new Set();

function resolveGlyph(name) {
  const glyph = MATERIAL_TO_LUCIDE[name];
  if (glyph) return glyph;
  if (process.env.NODE_ENV === "development" && name && !warned.has(name)) {
    warned.add(name);
    console.warn(`[Icon] no lucide glyph mapped for "${name}"; add it to src/shared/icons/materialToLucide.js`);
  }
  return Circle;
}

export default function Icon({ name, size = "md", label, className, ...props }) {
  const dimension = typeof size === "number" ? size : SIZES[size] || SIZES.md;
  const strokeWidth = typeof dimension === "number" && dimension >= 20 ? 1.75 : 2;
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" };

  return createElement(resolveGlyph(name), {
    size: dimension,
    strokeWidth,
    color: "currentColor",
    className,
    "data-icon": name,
    ...a11y,
    ...props,
  });
}
