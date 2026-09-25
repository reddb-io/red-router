<script lang="ts">
  import { NavigationMenu as Bits } from "bits-ui";
  import Button from "./Button.svelte";
  import {
    isNavigationMenuSection,
    type NavigationMenuEntry,
    type NavigationMenuLink,
  } from "./navigation-menu.behavior";
  import {
    navigationMenu,
    type NavigationMenuOrientation,
    type NavigationMenuSize,
  } from "./navigation-menu.variants";
  import { popover as popoverAppearance } from "./popover.variants";

  interface Props {
    label: string;
    items?: readonly NavigationMenuEntry[];
    value?: string;
    orientation?: NavigationMenuOrientation;
    size?: NavigationMenuSize;
    delayDuration?: number;
    skipDelayDuration?: number;
    class?: string;
  }

  let {
    label,
    items = [],
    value = $bindable(""),
    orientation = "horizontal",
    size = "md",
    delayDuration = 200,
    skipDelayDuration = 300,
    class: className,
  }: Props = $props();

  const slots = $derived(navigationMenu({ orientation, size }));

  function choose(link: NavigationMenuLink): void {
    link.onselect?.();
  }
</script>

<Bits.Root bind:value {orientation} {delayDuration} {skipDelayDuration}>
  {#snippet child({ props: rootProps })}
    <nav
      {...rootProps}
      aria-label={label}
      data-navigation-menu-root
      class={slots.root()}
    >
      <Bits.List class={slots.list()}>
        {#each items as item (item.id)}
          <Bits.Item value={item.id} openOnHover={false}>
            {#if isNavigationMenuSection(item)}
              <Bits.Trigger>
                {#snippet child({ props })}
                  <Button
                    {...props}
                    data-navigation-menu-control
                    data-navigation-menu-trigger
                    variant="ghost"
                    {size}
                    class={slots.control()}
                  >{item.label}</Button>
                {/snippet}
              </Bits.Trigger>
              <Bits.Content
                data-navigation-menu-surface
                aria-label={item.label}
                class={popoverAppearance({ class: slots.content({ class: className }) })}
              >
                <ul class={slots.links()}>
                  {#each item.links as link (link.id)}
                    <li>
                      <Bits.Link active={link.active} onSelect={() => choose(link)}>
                        {#snippet child({ props })}
                          <a {...props} href={link.href} class={slots.link()}>
                            <span>{link.label}</span>
                            {#if link.description !== undefined}
                              <span class={slots.description()}>{link.description}</span>
                            {/if}
                          </a>
                        {/snippet}
                      </Bits.Link>
                    </li>
                  {/each}
                </ul>
              </Bits.Content>
            {:else}
              <Bits.Link active={item.active} onSelect={() => choose(item)}>
                {#snippet child({ props })}
                  <a
                    {...props}
                    href={item.href}
                    data-navigation-menu-control
                    aria-current={item.active ? "page" : undefined}
                    class={slots.control()}
                  >{item.label}</a>
                {/snippet}
              </Bits.Link>
            {/if}
          </Bits.Item>
        {/each}
      </Bits.List>
    </nav>
  {/snippet}
</Bits.Root>
