import { tv, type VariantProps } from "tailwind-variants";

const SIDE = {
  start: {
    root: "md:grid-cols-[minmax(12rem,1fr)_minmax(0,3fr)]",
  },
  end: {
    root: "md:grid-cols-[minmax(0,3fr)_minmax(12rem,1fr)]",
  },
} as const;

export const sidebarLayout = tv({
  slots: {
    root: "grid min-w-0 items-start gap-[var(--reddb-spatial-gap-lg)]",
    region: "min-w-0",
    railRegion: "relative z-30 min-h-dvh min-w-0",
    panel: "min-w-0 border-e border-elevation-sunken-border bg-elevation-sunken-surface shadow-elevation-sunken",
    main: "min-w-0",
  },
  variants: {
    side: SIDE,
    rail: {
      false: {},
      true: {
        root: [
          "min-h-dvh items-stretch gap-0",
          "transition-[grid-template-columns] motion-reduce:transition-none",
        ].join(" "),
        panel: [
          "max-md:fixed max-md:inset-y-0 max-md:z-40 max-md:w-[min(20rem,calc(100vw-var(--reddb-spatial-control-height-md)-2*var(--reddb-spatial-inset-sm)))]",
          "max-md:overflow-y-auto max-md:p-[var(--reddb-spatial-inset-sm)]",
          "max-md:transition-transform motion-reduce:transition-none",
        ].join(" "),
      },
    },
    railOpen: {
      false: {
        railRegion: "w-0 overflow-hidden pointer-events-none md:w-0",
      },
      true: {},
    },
    panelOpen: {
      false: {
        panel: "max-md:pointer-events-none md:w-0 md:overflow-hidden md:pointer-events-none",
      },
      true: { panel: "max-md:translate-x-0" },
    },
  },
  compoundVariants: [
    {
      side: "start",
      rail: true,
      railOpen: true,
      class: {
        root: [
          "grid-cols-[calc(var(--reddb-spatial-control-height-md)+2*var(--reddb-spatial-inset-sm))_minmax(0,1fr)]",
        ].join(" "),
        panel: "max-md:start-[calc(var(--reddb-spatial-control-height-md)+2*var(--reddb-spatial-inset-sm))]",
        main: "max-md:col-start-2",
      },
    },
    {
      side: "end",
      rail: true,
      railOpen: true,
      class: {
        root: [
          "grid-cols-[minmax(0,1fr)_calc(var(--reddb-spatial-control-height-md)+2*var(--reddb-spatial-inset-sm))]",
        ].join(" "),
        panel: "max-md:end-[calc(var(--reddb-spatial-control-height-md)+2*var(--reddb-spatial-inset-sm))]",
        main: "max-md:col-start-1",
      },
    },
    {
      side: "start",
      rail: true,
      railOpen: false,
      class: {
        root: "grid-cols-[0_minmax(0,1fr)]",
        panel: "max-md:start-0",
        main: "max-md:col-start-2",
      },
    },
    {
      side: "end",
      rail: true,
      railOpen: false,
      class: {
        root: "grid-cols-[minmax(0,1fr)_0]",
        panel: "max-md:end-0",
        main: "max-md:col-start-1",
      },
    },
    {
      side: "start",
      rail: true,
      railOpen: true,
      panelOpen: false,
      class: {
        root: "md:grid-cols-[calc(var(--reddb-spatial-control-height-md)+2*var(--reddb-spatial-inset-sm))_0_minmax(0,1fr)]",
        panel: "max-md:-translate-x-full",
      },
    },
    {
      side: "start",
      rail: true,
      railOpen: true,
      panelOpen: true,
      class: {
        root: "md:grid-cols-[calc(var(--reddb-spatial-control-height-md)+2*var(--reddb-spatial-inset-sm))_minmax(12rem,1fr)_minmax(0,3fr)]",
      },
    },
    {
      side: "end",
      rail: true,
      railOpen: true,
      panelOpen: false,
      class: {
        root: "md:grid-cols-[minmax(0,1fr)_0_calc(var(--reddb-spatial-control-height-md)+2*var(--reddb-spatial-inset-sm))]",
        panel: "max-md:translate-x-full",
      },
    },
    {
      side: "end",
      rail: true,
      railOpen: true,
      panelOpen: true,
      class: {
        root: "md:grid-cols-[minmax(0,3fr)_minmax(12rem,1fr)_calc(var(--reddb-spatial-control-height-md)+2*var(--reddb-spatial-inset-sm))]",
      },
    },
    {
      side: "start",
      rail: true,
      railOpen: false,
      panelOpen: false,
      class: { root: "md:grid-cols-[0_0_minmax(0,1fr)]" },
    },
    {
      side: "start",
      rail: true,
      railOpen: false,
      panelOpen: true,
      class: { root: "md:grid-cols-[0_minmax(12rem,1fr)_minmax(0,3fr)]" },
    },
    {
      side: "end",
      rail: true,
      railOpen: false,
      panelOpen: false,
      class: { root: "md:grid-cols-[minmax(0,1fr)_0_0]" },
    },
    {
      side: "end",
      rail: true,
      railOpen: false,
      panelOpen: true,
      class: { root: "md:grid-cols-[minmax(0,3fr)_minmax(12rem,1fr)_0]" },
    },
  ],
  defaultVariants: { side: "start", rail: false, railOpen: true, panelOpen: false },
});

export type SidebarLayoutVariants = VariantProps<typeof sidebarLayout>;
export type SidebarSide = NonNullable<SidebarLayoutVariants["side"]>;
export const SIDEBAR_SIDES = Object.keys(SIDE) as readonly SidebarSide[];
