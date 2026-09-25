<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import {
    descriptionList,
    type DescriptionListGap,
    type DescriptionListItem,
  } from "./description-list.variants";

  interface Props extends Omit<HTMLAttributes<HTMLDListElement>, "class"> {
    items?: readonly DescriptionListItem[];
    gap?: DescriptionListGap;
    class?: string;
  }

  let { items = [], gap = "md", class: className, ...rest }: Props = $props();
  const slots = $derived(descriptionList({ gap }));
</script>

<dl
  {...(rest as Record<string, unknown>)}
  data-description-list
  class={slots.root({ class: className })}
>
  {#each items as item}
    <div data-description-item class={slots.item()}>
      <dt class={slots.term()}>
        {#if typeof item.term === "string"}{item.term}{:else}{@render item.term()}{/if}
      </dt>
      <dd class={slots.detail()}>
        {#if typeof item.detail === "string"}{item.detail}{:else}{@render item.detail()}{/if}
      </dd>
    </div>
  {/each}
</dl>
