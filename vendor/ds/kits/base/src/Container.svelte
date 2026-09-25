<!-- A universal content boundary whose inline inset follows local Density. -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { container } from "./container.variants";

  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "class"> {
    /** Extra classes merged onto the canonical content boundary. */
    class?: string;
    children?: Snippet;
  }

  const { class: className, children, ...rest }: Props = $props();
</script>

<div
  {...(rest as Record<string, unknown>)}
  data-container
  class={container({ class: className })}
>
  {@render children?.()}
</div>
