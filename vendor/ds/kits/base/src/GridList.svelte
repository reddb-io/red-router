<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import List from "./List.svelte";
  import { gridList, type GridListColumn } from "./grid-list.variants";
  import type { ListGap } from "./list.variants";

  interface Props extends Omit<HTMLAttributes<HTMLUListElement>, "class"> {
    columns?: GridListColumn;
    gap?: ListGap;
    class?: string;
    children?: Snippet;
  }

  let {
    columns = 1,
    gap = "md",
    class: className,
    children,
    ...rest
  }: Props = $props();
</script>

<List {...rest} data-grid-list {gap} class={gridList({ columns, class: className })}>
  {@render children?.()}
</List>
