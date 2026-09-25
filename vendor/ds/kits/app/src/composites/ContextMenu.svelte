<script lang="ts">
  import type { Snippet } from "svelte";
  import { ContextMenu as Bits } from "bits-ui";
  import {
    Button,
    Icon,
    dropdownMenuGroups,
    dropdownMenuItems,
    type DropdownMenuItem,
  } from "@reddb-io/design-system/base";
  import type { ContextMenuEntry } from "./command-surfaces.behavior";
  import { contextMenu, type ContextMenuSize } from "./context-menu.variants";

  interface Props {
    triggerLabel: string;
    contentLabel: string;
    items?: readonly ContextMenuEntry[];
    open?: boolean;
    disabled?: boolean;
    size?: ContextMenuSize;
    collisionPadding?: number;
    children?: Snippet;
    class?: string;
    targetClass?: string;
  }

  let {
    triggerLabel,
    contentLabel,
    items = [],
    open = $bindable(false),
    disabled = false,
    size = "md",
    collisionPadding = 8,
    children,
    class: className,
    targetClass,
  }: Props = $props();

  const uid = $props.id();
  const contentId = `${uid}-context-menu`;
  const groups = $derived(dropdownMenuGroups(items));
  const hasIcons = $derived(dropdownMenuItems(items).some((item) => item.icon !== undefined));
  const slots = $derived(contextMenu({ size }));
  function choose(item: DropdownMenuItem): void {
    item.onselect?.();
  }

  function openFromKeyboard(event: KeyboardEvent): void {
    if (disabled || !(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left,
      clientY: rect.bottom,
    }));
  }
</script>

{#snippet row(item: DropdownMenuItem)}
  {#if hasIcons}
    <span data-menu-item-icon aria-hidden="true" class={slots.icon()}>
      {#if item.icon !== undefined}<Icon icon={item.icon} {size} aria-hidden="true" />{/if}
    </span>
  {/if}
  {item.label}
{/snippet}

<Bits.Root bind:open>
  <Bits.Trigger {disabled}>
    {#snippet child({ props })}
      <Button
        {...props}
        data-context-menu-trigger
        tabindex={disabled ? -1 : 0}
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={contentId}
        aria-disabled={disabled ? "true" : undefined}
        variant="secondary"
        {size}
        class={targetClass}
        onkeydown={openFromKeyboard}
      >
        {#if children}{@render children()}{:else}{triggerLabel}{/if}
      </Button>
    {/snippet}
  </Bits.Trigger>

  <Bits.Portal>
    <Bits.Content id={contentId} avoidCollisions={true} {collisionPadding} loop={true}>
      {#snippet child({ props, wrapperProps })}
        <div {...wrapperProps}>
          <div
            {...props}
            id={contentId}
            data-context-menu-surface
            aria-label={contentLabel}
            class={slots.content({ class: className })}
          >
            {#each groups as group, index (index)}
              {#if index > 0}<Bits.Separator class={slots.separator()} />{/if}
              {@const headingId = `${contentId}-group-${index}`}
              <Bits.Group
                class={slots.group()}
                aria-labelledby={group.heading === undefined ? undefined : headingId}
              >
                {#if group.heading !== undefined}
                  <Bits.GroupHeading id={headingId} class={slots.heading()}>{group.heading}</Bits.GroupHeading>
                {/if}
                {#each group.items as item (item.id)}
                  <Bits.Item disabled={item.disabled} onSelect={() => choose(item)}>
                    {#snippet child({ props: itemProps })}
                      {#if item.href !== undefined}
                        <a {...itemProps} href={item.href} class={slots.item()}>{@render row(item)}</a>
                      {:else}
                        <div {...itemProps} class={slots.item()}>{@render row(item)}</div>
                      {/if}
                    {/snippet}
                  </Bits.Item>
                {/each}
              </Bits.Group>
            {/each}
          </div>
        </div>
      {/snippet}
    </Bits.Content>
  </Bits.Portal>
</Bits.Root>
