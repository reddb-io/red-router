<!--
  Button — a universal Base Primitive: it imports no other Kit component.

  The component owns the native element and behavior, `button.variants.ts`
  owns every class, and the Theme owns every value. Native button and anchor
  attributes pass through rather than being re-declared one by one.

  This is the one canonical Button implementation. Child Kits receive it by
  declaring Base as a parent and compose it through the explicit Base subpath;
  none shadows its name or behavior with a local implementation.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";
  import {
    button,
    buttonSpinner,
    type ButtonIntent,
    type ButtonSize,
    type ButtonVariant,
  } from "./button.variants";

  interface Common {
    /** Emphasis. Defaults to `primary`. */
    variant?: ButtonVariant;
    /** Semantic meaning. Defaults to `neutral`. */
    intent?: ButtonIntent;
    /** Control height and padding. Defaults to `md`. */
    size?: ButtonSize;
    /** Waiting state: keep the label, show a spinner, and become inert. */
    loading?: boolean;
    /** Full width, for a control that should fill its column. */
    block?: boolean;
    /** Out of action, using the native state available to each element. */
    disabled?: boolean;
    /** Extra classes, merged over the variant's own. */
    class?: string;
    children?: Snippet;
  }

  interface ButtonMode extends Common, Omit<HTMLButtonAttributes, "class" | "disabled"> {
    href?: never;
  }

  interface AnchorMode extends Common, Omit<HTMLAnchorAttributes, "class"> {
    /** Where it goes. Its presence is what makes this an <a>. */
    href: string;
  }

  type Props = ButtonMode | AnchorMode;

  const {
    variant = "primary",
    intent = "neutral",
    size = "md",
    loading = false,
    block = false,
    disabled = false,
    href,
    // A native button defaults to `button` so placing this control in a form
    // cannot submit by accident. An anchor receives no invented MIME hint.
    type,
    class: className,
    children,
    ...rest
  }: Props = $props();

  const tag = $derived(href !== undefined ? "a" : "button");
  const inert = $derived(disabled || loading);
  const spinner = $derived(buttonSpinner({ size }));

  // Anchors have no native disabled state, so an inert anchor loses its
  // destination and tab stop and declares the state accessibly.
  const native = $derived(
    tag === "a"
      ? { href: inert ? undefined : href, type, tabindex: inert ? -1 : undefined }
      : { type: type ?? "button", disabled: inert },
  );
</script>

<!--
  Props are typed at the caller boundary above. The remainder of the
  button/anchor union is spread as a record because TypeScript cannot represent
  the union produced by checking roughly 440 native attributes a second time.
-->
<svelte:element
  this={tag}
  {...(rest as Record<string, unknown>)}
  {...native}
  class={button({ variant, intent, size, block, class: className })}
  aria-busy={loading ? "true" : undefined}
  aria-disabled={tag === "a" && inert ? "true" : undefined}
>
  {#if loading}
    <!-- `aria-busy` carries the announcement; the spinner is visual only. -->
    <svg class={spinner.root()} viewBox="0 0 24 24" aria-hidden="true">
      <circle class={spinner.track()} cx="12" cy="12" r="9" stroke-width="3" />
      <path class={spinner.head()} d="M21 12a9 9 0 0 0-9-9" stroke-width="3" stroke-linecap="round" />
    </svg>
  {/if}
  {@render children?.()}
</svelte:element>
