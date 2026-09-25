<!-- Token-backed vertical flow that inherits the nearest Density scope. -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { stack, type StackGap } from "./stack.variants";

  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "class"> {
    /** Space between children. Each value names a Density-owned role. */
    gap?: StackGap;
    /** Extra classes merged onto the vertical flow. */
    class?: string;
    children?: Snippet;
  }

  const { gap = "md", class: className, children, ...rest }: Props = $props();
</script>

<div
  {...(rest as Record<string, unknown>)}
  data-stack
  class={stack({ gap, class: className })}
>
  {@render children?.()}
</div>
