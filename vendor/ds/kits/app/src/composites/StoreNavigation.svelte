<script lang="ts">
  import { Navbar, type NavbarCollapse, type NavbarLink } from "@reddb-io/design-system/base";
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { navigationItems, type ApplicationNavigationItem } from "./navigation.behavior";
  import { storeNavigation } from "./store-navigation.variants";

  interface Props extends Omit<HTMLAttributes<HTMLElement>, "class"> {
    label: string;
    items: readonly ApplicationNavigationItem[];
    currentId: string;
    collapse?: NavbarCollapse;
    announcement?: Snippet;
    brand?: Snippet;
    actions?: Snippet;
    class?: string;
  }

  const {
    label,
    items,
    currentId,
    collapse = "responsive",
    announcement,
    brand,
    actions,
    class: className,
    ...rest
  }: Props = $props();

  const links: readonly NavbarLink[] = $derived(
    navigationItems(items, currentId).map((item) => ({
      id: item.id,
      label: item.label,
      href: item.href,
      current: item.current,
      disabled: item.disabled,
      onselect: item.onselect,
    })),
  );
  const styles = $derived(storeNavigation());
</script>

<div {...rest} data-store-navigation="" class={styles.root({ class: className })}>
  {#if announcement}
    <div data-store-announcement="" class={styles.announcement()}>{@render announcement()}</div>
  {/if}
  <Navbar {label} {links} {collapse} {brand} {actions} class={styles.navbar()} />
</div>
