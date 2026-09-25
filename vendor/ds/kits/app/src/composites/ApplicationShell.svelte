<!--
  The canonical application frame: keyboard bypass, optional product chrome,
  and one focusable main landmark. Container and Stack remain the Base Kit's
  contracts; this Composite only puts them in the application-specific order.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { Container, SkipLink, Stack } from "@reddb-io/design-system/base";
  import { applicationShell } from "./application-shell.variants";

  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "class"> {
    /** The id shared by the keyboard bypass and the main landmark. */
    mainId?: string;
    /** Product-wide chrome before the page content. */
    header?: Snippet;
    /** Page content; its arrangement and business language stay caller-owned. */
    children?: Snippet;
    /** Product-wide status or legal chrome after the page content. */
    footer?: Snippet;
    /** Let application layouts consume the viewport edge instead of the prose measure. */
    fullWidth?: boolean;
    /**
     * The shell is embedded in a host document that already owns the page's
     * `<main>` (a preview, a documentation frame). Its main region stays the
     * focusable skip-link target but is not a second `main` landmark.
     */
    embedded?: boolean;
    /** Extra classes merged onto the application frame. */
    class?: string;
  }

  let {
    mainId = "main-content",
    header,
    children,
    footer,
    fullWidth = false,
    embedded = false,
    class: className,
    ...rest
  }: Props = $props();

  const slots = $derived(applicationShell());
  const containerClass = $derived(fullWidth ? "max-w-none px-0" : undefined);
</script>

<div
  {...(rest as Record<string, unknown>)}
  data-application-shell
  class={slots.root({ class: className })}
>
  <SkipLink href={`#${mainId}`} />

  {#if header}
    <header class={slots.header()} data-application-shell-region="header">
      <Container class={slots.headerContainer({ class: containerClass })}>
        {@render header()}
      </Container>
    </header>
  {/if}

  <svelte:element
    this={embedded ? "div" : "main"}
    id={mainId}
    tabindex="-1"
    class={slots.main()}
    data-application-shell-region="main"
  >
    <Container
      class={slots.mainContainer({
        class: fullWidth ? "h-full min-h-0 max-w-none px-0 py-0" : undefined,
      })}
    >
      <Stack class={fullWidth ? "h-full min-h-0" : undefined}>{@render children?.()}</Stack>
    </Container>
  </svelte:element>

  {#if footer}
    <footer class={slots.footer()} data-application-shell-region="footer">
      <Container
        class={slots.footerContainer({
          class: fullWidth ? "max-w-none px-0" : undefined,
        })}
      >{@render footer()}</Container>
    </footer>
  {/if}
</div>
