<!-- The only sanctioned seam between a Kit component and a lucide glyph. -->
<script lang="ts" module>
  import type { IconProps as LucideIconProps } from "lucide-svelte";
  import type { Component } from "svelte";

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

  export type IconGlyphProps = LucideIconProps;
  export type IconGlyph = Component<IconGlyphProps>;
</script>

<script lang="ts">
  import type { SVGAttributes } from "svelte/elements";

  interface Props
    extends Omit<
      SVGAttributes<SVGSVGElement>,
      "color" | "height" | "stroke" | "stroke-width" | "width"
    > {
    /** A lucide-svelte glyph imported by the consumer. */
    icon: IconGlyph;
    /** Density-responsive DS size. */
    size?: IconSize;
    /**
     * Semantic Theme color; raw color values are deliberately not accepted.
     * `current` inherits the surrounding ink, so a glyph follows its control's
     * hover and selected states or a caller's token-backed text class.
     */
    color?: IconColor;
  }

  let {
    icon: Glyph,
    size = "md",
    color = "foreground",
    class: className,
    ...rest
  }: Props = $props();

  const dimension = $derived(`var(--reddb-spatial-icon-size-${size})`);
  const resolvedColor = $derived(
    color === "current" ? "currentColor" : `var(--reddb-color-${color})`,
  );
  // Keep the public seam exact (`IconGlyph` is Lucide's own props) while
  // preventing Svelte's template checker from expanding the complete SVG
  // attribute union at this dynamic component boundary.
  const RenderGlyph = $derived(Glyph as Component<Record<string, unknown>>);
</script>

<RenderGlyph
  {...rest}
  data-icon
  size={dimension}
  color={resolvedColor}
  strokeWidth={2}
  class={className}
/>
