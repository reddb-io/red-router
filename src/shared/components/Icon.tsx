/**
 * The only sanctioned seam between a component and a lucide glyph, mirroring the RedDB design
 * system's `Icon` wrapper (design-system/kits/base/src/Icon.svelte):
 *
 * - `size` is a DS density size (`sm | md | lg`) resolved from `--reddb-spatial-icon-size-*`;
 * - the stroke width is fixed at 2;
 * - `color` accepts only semantic theme roles; raw colours are deliberately not accepted.
 *   `current` inherits the surrounding ink, so a glyph follows its control's hover and selected
 *   states or a caller's token-backed text class;
 * - decorative glyphs (no `aria-label` / `title`) are hidden from assistive technology.
 */
import type { CSSProperties } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";

export const ICON_SIZES = ["sm", "md", "lg"] as const;
export type IconSize = (typeof ICON_SIZES)[number];

export const ICON_COLORS = [
  "current",
  "foreground",
  "ink-muted",
  "muted",
  "primary",
  "on-primary",
  "feedback-danger-foreground",
  "feedback-success-foreground",
  "feedback-warning-foreground",
] as const;
export type IconColor = (typeof ICON_COLORS)[number];

/** A lucide-react glyph component, imported by name by the consumer. */
export type IconGlyph = LucideIcon;

/**
 * Semantic role -> the Tailwind text utility generated from the design-system theme
 * (src/shared/design-system/vendor/theme/theme.css). Full class names stay literal so Tailwind
 * can see them.
 */
const COLOR_CLASS: Record<IconColor, string> = {
  current: "text-current",
  foreground: "text-foreground",
  "ink-muted": "text-ink-muted",
  muted: "text-muted",
  primary: "text-primary",
  "on-primary": "text-on-primary",
  "feedback-danger-foreground": "text-feedback-danger-foreground",
  "feedback-success-foreground": "text-feedback-success-foreground",
  "feedback-warning-foreground": "text-feedback-warning-foreground",
};

export interface IconProps extends Omit<
  LucideProps,
  "color" | "stroke" | "strokeWidth" | "size" | "absoluteStrokeWidth"
> {
  /** A lucide-react glyph imported by the consumer. */
  icon: IconGlyph;
  /** Density-responsive DS size. */
  size?: IconSize;
  /** Semantic theme colour role. */
  color?: IconColor;
}

export default function Icon({
  icon: Glyph,
  size = "md",
  color = "foreground",
  className,
  style,
  ...rest
}: IconProps) {
  const dimension = `var(--reddb-spatial-icon-size-${size})`;
  const labelled = rest["aria-label"] !== undefined || (rest as { title?: string }).title;
  const sizeStyle: CSSProperties = { width: dimension, height: dimension, ...style };
  const classes = ["shrink-0", COLOR_CLASS[color], className].filter(Boolean).join(" ");

  return (
    <Glyph
      aria-hidden={labelled ? undefined : "true"}
      {...rest}
      data-icon=""
      strokeWidth={2}
      className={classes}
      style={sizeStyle}
    />
  );
}
