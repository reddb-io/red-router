<script module lang="ts">
  export interface BreadcrumbItem {
    id: string;
    label: string;
    href?: string;
    current?: boolean;
  }
</script>

<script lang="ts">
  import Link from "./Link.svelte";
  import { breadcrumbs } from "./breadcrumbs.variants";

  interface Props {
    items: readonly BreadcrumbItem[];
    label?: string;
    class?: string;
  }

  let { items, label = "Breadcrumbs", class: className }: Props = $props();
  const styles = breadcrumbs();
</script>

<nav aria-label={label} data-breadcrumbs class={styles.root({ class: className })}>
  <ol class={styles.list()}>
    {#each items as item, index (item.id)}
      <li class={styles.item()}>
        {#if item.current}
          <span aria-current="page" class={styles.current()}>{item.label}</span>
        {:else if item.href !== undefined}
          <Link href={item.href}>{item.label}</Link>
        {:else}
          <span>{item.label}</span>
        {/if}
        {#if index < items.length - 1}<span aria-hidden="true" class={styles.separator()}>/</span>{/if}
      </li>
    {/each}
  </ol>
</nav>
