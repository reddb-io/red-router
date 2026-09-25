<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import { skeleton, type SkeletonShape } from "./skeleton.variants";

  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "class"> {
    shape?: SkeletonShape;
    /** Optional announcement when this placeholder owns the loading state. */
    label?: string;
    class?: string;
  }

  const {
    shape = "text",
    label,
    class: className,
    ...rest
  }: Props = $props();
</script>

<div
  {...(rest as Record<string, unknown>)}
  data-skeleton
  data-shape={shape}
  class={skeleton({ shape, class: className })}
  role={label ? "status" : undefined}
  aria-label={label}
  aria-live={label ? "polite" : undefined}
  aria-busy={label ? "true" : undefined}
  aria-hidden={label ? undefined : "true"}
></div>
