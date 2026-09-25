<script module lang="ts">
  export type NavbarCollapse = "responsive" | "expanded" | "collapsed";
  export type NavbarAlign = "start" | "center";
  export const NAVBAR_ALIGNMENTS = ["start", "center"] as const satisfies readonly NavbarAlign[];
  export const NAVBAR_COLLAPSE = [
    "responsive",
    "expanded",
    "collapsed",
  ] as const satisfies readonly NavbarCollapse[];

  export interface NavbarArrangements {
    rail: boolean;
    compact: boolean;
  }

  /** Decide which arrangements exist without consulting viewport state in JavaScript. */
  export function arrangements(collapse: NavbarCollapse): NavbarArrangements {
    return { rail: collapse !== "collapsed", compact: collapse !== "expanded" };
  }

  export interface NavbarLink {
    id: string;
    label: string;
    href?: string;
    current?: boolean | "page" | "step" | "location" | "date" | "time" | "true";
    active?: boolean;
    disabled?: boolean;
    onselect?: () => void;
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import Button from "./Button.svelte";
  import Link from "./Link.svelte";
  import { navbar } from "./navbar.variants";

  interface Props {
    links?: readonly NavbarLink[];
    collapse?: NavbarCollapse;
    align?: NavbarAlign;
    open?: boolean;
    label?: string;
    menuLabel?: string;
    brand?: Snippet;
    actions?: Snippet;
    class?: string;
  }

  let {
    links = [],
    collapse = "responsive",
    align = "start",
    open = $bindable(false),
    label = "Main",
    menuLabel = "Menu",
    brand,
    actions,
    class: className,
  }: Props = $props();

  const uid = $props.id();
  const panelId = `${uid}-menu`;
  let root: HTMLElement | undefined = $state();
  const styles = $derived(navbar({ collapse, align, open }));
  const shown = $derived(arrangements(collapse));

  function currentValue(link: NavbarLink): NavbarLink["current"] | undefined {
    if (link.current === true || link.active) return "page";
    return link.current || undefined;
  }

  function dismiss(): void {
    if (!open) return;
    open = false;
    root?.querySelector<HTMLButtonElement>("[data-navbar-toggle]")?.focus();
  }

  $effect(() => {
    const element = root;
    if (!open || element === undefined) return;
    const onkeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") dismiss();
    };
    element.addEventListener("keydown", onkeydown);
    return () => element.removeEventListener("keydown", onkeydown);
  });
</script>

<nav
  bind:this={root}
  aria-label={label}
  data-navbar
  data-navbar-align={align}
  data-navbar-collapse={collapse}
  class={styles.root({ class: className })}
>
  {#if shown.rail}
    <div data-navbar-arrangement="rail" class={styles.rail()}>
      <div data-navbar-region="brand" class={styles.brand()}>{@render brand?.()}</div>
      {#if links.length > 0}
        <ul data-navbar-region="links" class={styles.links()}>
          {#each links as link (link.id)}
            <li>
              {#if link.disabled && link.href !== undefined}
                <a aria-disabled="true" data-navbar-link={link.id} class={styles.link()}>{link.label}</a>
              {:else if link.href !== undefined}
                <Link
                  href={link.href}
                  aria-current={currentValue(link)}
                  data-navbar-link={link.id}
                  class={styles.link()}
                  onclick={link.onselect}
                >{link.label}</Link>
              {:else}
                <Button
                  variant="ghost"
                  disabled={link.disabled}
                  data-navbar-link={link.id}
                  class={styles.link()}
                  onclick={link.onselect}
                >{link.label}</Button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      <div data-navbar-region="actions" class={styles.actions()}>{@render actions?.()}</div>
    </div>
  {/if}

  {#if shown.compact}
    <div data-navbar-arrangement="compact" class={styles.compact()}>
      <div data-navbar-region="brand" class={styles.brand()}>{@render brand?.()}</div>
      <Button
        variant="ghost"
        class={styles.toggle()}
        data-navbar-toggle
        aria-label={menuLabel}
        aria-expanded={open}
        aria-controls={panelId}
        onclick={() => (open = !open)}
      >{menuLabel}</Button>
    </div>
    <div id={panelId} data-navbar-panel hidden={!open} class={styles.panel()}>
      {#if links.length > 0}
        <ul data-navbar-region="links" class={styles.panelLinks()}>
          {#each links as link (link.id)}
            <li>
              {#if link.disabled && link.href !== undefined}
                <a aria-disabled="true" data-navbar-link={link.id} class={styles.panelLink()}>{link.label}</a>
              {:else if link.href !== undefined}
                <Link
                  href={link.href}
                  aria-current={currentValue(link)}
                  data-navbar-link={link.id}
                  class={styles.panelLink()}
                  onclick={() => {
                    link.onselect?.();
                    open = false;
                  }}
                >{link.label}</Link>
              {:else}
                <Button
                  variant="ghost"
                  disabled={link.disabled}
                  data-navbar-link={link.id}
                  class={styles.panelLink()}
                  onclick={() => {
                    link.onselect?.();
                    open = false;
                  }}
                >{link.label}</Button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      <div data-navbar-region="actions" class={styles.actions()}>{@render actions?.()}</div>
    </div>
  {/if}
</nav>
