<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import Card from "./Card.svelte";
  import type { CardPadding, CardVariant } from "./card.variants";

  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "class" | "title"> {
    variant?: CardVariant;
    padding?: CardPadding;
    title?: string;
    description?: string;
    header?: Snippet;
    footer?: Snippet;
    class?: string;
    children?: Snippet;
  }

  let {
    variant = "outline",
    padding = "md",
    title,
    description,
    header,
    footer,
    class: className,
    children,
    ...rest
  }: Props = $props();
</script>

<Card
  {...rest}
  data-list-container
  {variant}
  {padding}
  {title}
  {description}
  {header}
  {footer}
  class={className}
>
  {@render children?.()}
</Card>
