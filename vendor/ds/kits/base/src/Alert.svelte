<!--
  Alert — a universal Base Primitive for one Feedback Role.

  Success and warning are polite status updates. Danger is an assertive error
  alert. The component fixes that semantic behavior while the Theme owns the
  replaceable Brand-material mapping behind each role.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { alert, type AlertFeedbackRole } from "./alert.variants";

  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "class" | "role" | "title"> {
    /** The DS-owned UX meaning this message carries. */
    feedback: AlertFeedbackRole;
    /** Optional visible heading; this is message content, not the native title tooltip. */
    title?: string;
    /** Extra classes, merged over the canonical Feedback Role appearance. */
    class?: string;
    children?: Snippet;
  }

  const { feedback, title, class: className, children, ...rest }: Props = $props();
  const announcementRole = $derived(feedback === "danger" ? "alert" : "status");
</script>

<div
  {...(rest as Record<string, unknown>)}
  role={announcementRole}
  class={alert({ feedback, class: className })}
>
  {#if title}<p class="font-medium">{title}</p>{/if}
  {#if children}
    <div class={title ? "mt-[var(--reddb-spatial-gap-sm)]" : undefined}>{@render children()}</div>
  {/if}
</div>
