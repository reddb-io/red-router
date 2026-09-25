<!-- Accessible tab selection and keyboard navigation over caller-owned panel content. -->
<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import { Tabs as Bits } from "bits-ui";
  import Button from "./Button.svelte";
  import { tabs, type TabItem } from "./tabs.variants";

  interface Props {
    /** Accessible name for the tablist. */
    label: string;
    /** Stable values and visible labels; panel content remains caller-owned. */
    items: readonly TabItem[];
    /** Selected tab value; defaults to the first enabled tab. */
    value?: string;
    orientation?: "horizontal" | "vertical";
    disabled?: boolean;
    /** Select the panel containing a same-page fragment target. */
    followHash?: boolean;
    onchange?: (value: string) => void;
    children?: Snippet<[{ value: string }]>;
    class?: string;
    listClass?: string;
    triggerClass?: string;
    contentClass?: string;
  }

  let {
    label,
    items,
    value = $bindable(""),
    orientation = "horizontal",
    disabled = false,
    followHash = false,
    onchange,
    children,
    class: className,
    listClass,
    triggerClass,
    contentClass,
  }: Props = $props();

  const styles = tabs();
  const ownerId = $props.id();
  let root = $state<HTMLElement>();
  const selected = $derived(
    items.some((item) => !item.disabled && item.value === value)
      ? value
      : (items.find((item) => !item.disabled)?.value ?? ""),
  );

  function select(next: string): void {
    if (next === selected) return;
    value = next;
    onchange?.(next);
  }

  async function selectFragment(): Promise<void> {
    if (!root || !location.hash) return;
    const targetId = decodeURIComponent(location.hash.slice(1));
    const target = document.getElementById(targetId);
    if (!target || !root.contains(target)) return;
    const panel = [...root.querySelectorAll<HTMLElement>("[data-tabs-owner]")]
      .filter((candidate) => candidate.dataset.tabsOwner === ownerId)
      .find((candidate) => candidate.contains(target));
    const next = panel?.dataset.tabValue;
    if (!next || !items.some((item) => item.value === next && !item.disabled)) return;
    select(next);
    await tick();
    await new Promise<void>((resolve) => setTimeout(resolve));
    const visibleTarget = document.getElementById(targetId);
    visibleTarget?.focus({ preventScroll: true });
    if (typeof visibleTarget?.scrollIntoView === "function") {
      visibleTarget.scrollIntoView({ block: "nearest" });
    }
  }

  $effect(() => {
    if (!followHash || !root || typeof window === "undefined") return;
    const handleHash = () => void selectFragment();
    handleHash();
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  });
</script>

<div
  bind:this={root}
  data-tabs
  aria-label={label}
  class={styles.root({ class: className })}
>
  <Bits.Root
    value={selected}
    onValueChange={select}
    {orientation}
    activationMode="automatic"
    loop={true}
    {disabled}
    aria-label={label}
  >
    <Bits.List aria-label={label} class={styles.list({ class: listClass })}>
      {#each items as item (item.value)}
        <Bits.Trigger value={item.value} disabled={item.disabled}>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="sm"
              class={styles.trigger({ class: triggerClass })}
            >{item.label}</Button>
          {/snippet}
        </Bits.Trigger>
      {/each}
    </Bits.List>

    {#each items as item (item.value)}
      <Bits.Content
        value={item.value}
        class={styles.content({ class: contentClass })}
        tabindex={0}
        data-tabs-owner={ownerId}
        data-tab-value={item.value}
      >
        {@render children?.({ value: item.value })}
      </Bits.Content>
    {/each}
  </Bits.Root>
</div>
