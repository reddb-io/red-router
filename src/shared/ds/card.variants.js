// GENERATED from vendor/ds/kits/base/card.variants.ts by scripts/sync-ds-variants.mjs — do not edit.
import { tv,                   } from "tailwind-variants";

const VARIANT = {
  outline: {},
  plain: {
    root: "border-transparent",
    header: "border-transparent",
    footer: "border-transparent",
  },
}         ;

const RAISED = {
  false: {},
  true: { root: "shadow-elevation-raised" },
}         ;

const TONE = {
  neutral: {
    root: "bg-background text-foreground",
    header: "text-foreground",
    title: "text-foreground",
    description: "text-ink-muted",
    body: "text-foreground",
    footer: "text-foreground",
  },
  brand: {
    root: "bg-[var(--reddb-color-primary)] text-[var(--reddb-color-on-primary)]",
    header: "text-[var(--reddb-color-on-primary)]",
    title: "text-[var(--reddb-color-on-primary)]",
    description: "text-[var(--reddb-color-on-primary)]",
    body: "text-[var(--reddb-color-on-primary)]",
    footer: "text-[var(--reddb-color-on-primary)]",
  },
  success: {
    root: "bg-[var(--reddb-color-feedback-success-surface)] text-[var(--reddb-color-feedback-success-foreground)]",
    header: "text-[var(--reddb-color-feedback-success-foreground)]",
    title: "text-[var(--reddb-color-feedback-success-foreground)]",
    description: "text-[var(--reddb-color-feedback-success-foreground)]",
    body: "text-[var(--reddb-color-feedback-success-foreground)]",
    footer: "text-[var(--reddb-color-feedback-success-foreground)]",
  },
  warning: {
    root: "bg-[var(--reddb-color-feedback-warning-surface)] text-[var(--reddb-color-feedback-warning-foreground)]",
    header: "text-[var(--reddb-color-feedback-warning-foreground)]",
    title: "text-[var(--reddb-color-feedback-warning-foreground)]",
    description: "text-[var(--reddb-color-feedback-warning-foreground)]",
    body: "text-[var(--reddb-color-feedback-warning-foreground)]",
    footer: "text-[var(--reddb-color-feedback-warning-foreground)]",
  },
  danger: {
    root: "bg-[var(--reddb-color-feedback-danger-surface)] text-[var(--reddb-color-feedback-danger-foreground)]",
    header: "text-[var(--reddb-color-feedback-danger-foreground)]",
    title: "text-[var(--reddb-color-feedback-danger-foreground)]",
    description: "text-[var(--reddb-color-feedback-danger-foreground)]",
    body: "text-[var(--reddb-color-feedback-danger-foreground)]",
    footer: "text-[var(--reddb-color-feedback-danger-foreground)]",
  },
  info: {
    root: "bg-[var(--reddb-color-muted)] text-[var(--reddb-color-foreground)]",
    header: "text-[var(--reddb-color-foreground)]",
    title: "text-[var(--reddb-color-foreground)]",
    description: "text-[var(--reddb-color-foreground)]",
    body: "text-[var(--reddb-color-foreground)]",
    footer: "text-[var(--reddb-color-foreground)]",
  },
}         ;

const PADDING = {
  none: { header: "p-0", body: "p-0", footer: "p-0" },
  sm: {
    header: "p-[var(--reddb-spatial-inset-sm)]",
    body: "p-[var(--reddb-spatial-inset-sm)]",
    footer: "p-[var(--reddb-spatial-inset-sm)]",
  },
  md: {
    header: "p-[var(--reddb-spatial-inset-md)]",
    body: "p-[var(--reddb-spatial-inset-md)]",
    footer: "p-[var(--reddb-spatial-inset-md)]",
  },
}         ;

const ACTIONS_ALIGN = {
  start: { footer: "justify-start" },
  center: { footer: "justify-center" },
  end: { footer: "justify-end" },
  between: { footer: "justify-between" },
}         ;

const ORIENTATION = {
  vertical: {
    root: "flex flex-col",
    layout: "flex min-w-0 flex-1 flex-col",
    media: "w-full",
    content: "flex min-w-0 flex-1 flex-col",
  },
  horizontal: {
    root: "",
    layout: "flex min-w-0 flex-1 flex-col @sm/card:flex-row",
    content: "flex min-w-0 flex-1 flex-col",
  },
}         ;

const MEDIA_FIT = {
  cover: { media: "[&>*]:object-cover" },
  contain: { media: "[&>*]:object-contain" },
}         ;

const MEDIA_POSITION = {
  center: { media: "[&>*]:object-center" },
  top: { media: "[&>*]:object-top" },
  bottom: { media: "[&>*]:object-bottom" },
  start: { media: "[&>*]:object-left" },
  end: { media: "[&>*]:object-right" },
}         ;

const MEDIA_RATIO = {
  "16/9": { media: "aspect-video [&>*]:h-full" },
  "4/3": { media: "aspect-[4/3] [&>*]:h-full" },
  "1/1": { media: "aspect-square [&>*]:h-full" },
  auto: { media: "aspect-auto [&>*]:h-auto" },
}         ;

const MEDIA_SPAN = {
  third: {},
  "two-fifths": {},
  half: {},
  background: {
    root: "relative isolate",
    media: "absolute inset-0 size-full",
    content: "relative z-10",
  },
}         ;

export const card = tv({
  slots: {
    root: "@container/card w-full overflow-hidden rounded-lg border",
    layout: "",
    media: "relative shrink-0 overflow-hidden [&>*]:block [&>*]:w-full",
    content: "",
    header: "flex flex-col gap-[var(--reddb-spatial-gap-sm)] border-b",
    titleRow: "flex items-center gap-[var(--reddb-spatial-gap-sm)]",
    icon: "shrink-0",
    title: "text-base font-medium leading-none",
    description: "max-w-prose text-sm",
    body: "flex-1",
    footer: "flex flex-wrap items-center gap-[var(--reddb-spatial-gap-md)] border-t",
  },
  variants: {
    variant: VARIANT,
    raised: RAISED,
    tone: TONE,
    padding: PADDING,
    actionsAlign: ACTIONS_ALIGN,
    orientation: ORIENTATION,
    fit: MEDIA_FIT,
    position: MEDIA_POSITION,
    ratio: MEDIA_RATIO,
    span: MEDIA_SPAN,
  },
  compoundVariants: [
    {
      variant: "outline",
      tone: "neutral",
      class: { root: "border-muted", header: "border-muted", footer: "border-muted" },
    },
    {
      variant: "outline",
      tone: "brand",
      class: {
        root: "border-[var(--reddb-color-primary)]",
        header: "border-[var(--reddb-color-primary)]",
        footer: "border-[var(--reddb-color-primary)]",
      },
    },
    {
      variant: "outline",
      tone: "success",
      class: {
        root: "border-[var(--reddb-color-feedback-success-border)]",
        header: "border-[var(--reddb-color-feedback-success-border)]",
        footer: "border-[var(--reddb-color-feedback-success-border)]",
      },
    },
    {
      variant: "outline",
      tone: "warning",
      class: {
        root: "border-[var(--reddb-color-feedback-warning-border)]",
        header: "border-[var(--reddb-color-feedback-warning-border)]",
        footer: "border-[var(--reddb-color-feedback-warning-border)]",
      },
    },
    {
      variant: "outline",
      tone: "danger",
      class: {
        root: "border-[var(--reddb-color-feedback-danger-border)]",
        header: "border-[var(--reddb-color-feedback-danger-border)]",
        footer: "border-[var(--reddb-color-feedback-danger-border)]",
      },
    },
    {
      variant: "outline",
      tone: "info",
      class: {
        root: "border-[var(--reddb-color-muted)]",
        header: "border-[var(--reddb-color-muted)]",
        footer: "border-[var(--reddb-color-muted)]",
      },
    },
    {
      raised: true,
      tone: "neutral",
      class: { root: "bg-elevation-raised-surface" },
    },
    {
      raised: true,
      variant: "outline",
      tone: "neutral",
      class: { root: "border-elevation-raised-border" },
    },
    {
      orientation: "horizontal",
      span: "third",
      class: { media: "@sm/card:w-1/3" },
    },
    {
      orientation: "horizontal",
      span: "two-fifths",
      class: { media: "@sm/card:w-2/5" },
    },
    {
      orientation: "horizontal",
      span: "half",
      class: { media: "@sm/card:w-1/2" },
    },
  ],
  defaultVariants: {
    variant: "outline",
    raised: false,
    tone: "neutral",
    padding: "md",
    actionsAlign: "start",
    orientation: "vertical",
    fit: "cover",
    position: "center",
    ratio: "16/9",
    span: "two-fifths",
  },
});

                                                     
                                                               
                                                         
                                                               
                                                                         
                                                                       
                                                            
                                                                      
                                                                
                                                              

export const CARD_VARIANTS = Object.keys(VARIANT)                          ;
export const CARD_TONES = Object.keys(TONE)                       ;
export const CARD_PADDINGS = Object.keys(PADDING)                          ;
export const CARD_ACTIONS_ALIGNMENTS = Object.keys(
  ACTIONS_ALIGN,
)                               ;
export const CARD_ORIENTATIONS = Object.keys(ORIENTATION)                              ;
export const CARD_MEDIA_FITS = Object.keys(MEDIA_FIT)                           ;
export const CARD_MEDIA_POSITIONS = Object.keys(
  MEDIA_POSITION,
)                                ;
export const CARD_MEDIA_RATIOS = Object.keys(MEDIA_RATIO)                             ;
export const CARD_MEDIA_SPANS = Object.keys(MEDIA_SPAN)                            ;
