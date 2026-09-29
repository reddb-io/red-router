import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Static guards for the shared visual identity (Phase 1: graph-paper grid wallpaper).
// These lock in the cross-product design contract so an accidental edit can't silently
// remove the grid or re-introduce the opaque wrapper that hides it. See design.md.

const globalsCss = fs.readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
const bridgeCss = fs.readFileSync(
  new URL("../../src/shared/design-system/bridge.css", import.meta.url),
  "utf8"
);
const dashboardLayout = fs.readFileSync(
  new URL("../../src/shared/components/layouts/DashboardLayout.tsx", import.meta.url),
  "utf8"
);

test("grid wallpaper uses the RedDB foundation in both color schemes", () => {
  assert.match(bridgeCss, /--grid-line:\s*var\(--reddb-color-muted\)/);
  assert.match(bridgeCss, /--grid-size:\s*var\(--reddb-spatial-control-height-md\)/);
  assert.match(bridgeCss, /--section-alt:\s*var\(--reddb-color-elevation-sunken-surface\)/);
});

test("globals.css renders the grid via a body::before fixed layer", () => {
  // The pseudo-element must exist and be the grid renderer.
  const before = globalsCss.slice(globalsCss.indexOf("body::before"));
  assert.ok(before.length > 0, "body::before rule is present");
  assert.match(before, /position:\s*fixed/);
  assert.match(before, /z-index:\s*-1/);
  assert.match(before, /pointer-events:\s*none/);
  assert.match(before, /linear-gradient\(to right,\s*var\(--grid-line\) 1px, transparent 1px\)/);
  assert.match(before, /linear-gradient\(to bottom,\s*var\(--grid-line\) 1px, transparent 1px\)/);
  assert.match(before, /background-size:\s*var\(--grid-size\) var\(--grid-size\)/);
});

test("globals.css adds the shared identity tokens", () => {
  assert.match(bridgeCss, /--surface-2:\s*var\(--reddb-color-elevation-raised-surface\)/);
  assert.match(bridgeCss, /--radius:\s*var\(--reddb-radius-lg\)/);
  assert.match(
    bridgeCss,
    /--grad-brand:\s*linear-gradient\(var\(--color-primary\),\s*var\(--color-primary\)\)/
  );
  // exposed to Tailwind as bg-surface-2 for later phases
  assert.match(globalsCss, /--color-surface-2:\s*var\(--surface-2\)/);
});

test("DashboardLayout wrapper stays transparent so the grid shows through", () => {
  // Regression guard: the outer shell must NOT paint an opaque bg over the body grid.
  assert.ok(
    !dashboardLayout.includes("overflow-hidden bg-bg"),
    "DashboardLayout outer wrapper must not use bg-bg (it would hide the grid wallpaper)"
  );
  assert.ok(
    dashboardLayout.includes('className="flex h-dvh min-h-0 w-full overflow-hidden"'),
    "DashboardLayout outer wrapper is present and transparent"
  );
});

// ── Phase 2: primitives adopt the shared radius scale, brand gradient & border token ──

const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("globals.css exposes the semantic radius utilities", () => {
  assert.match(bridgeCss, /--radius-control:\s*var\(--reddb-radius-md\)/);
  assert.match(globalsCss, /--radius-card:\s*var\(--radius\)/); // @theme → rounded-card (14px)
  assert.match(globalsCss, /--radius-control:\s*var\(--radius-control\)/); // @theme → rounded-control
});

test("Button, Badge and Card render through the canonical DS contracts", () => {
  const button = read("../../src/shared/components/Button.tsx");
  assert.ok(button.includes("design-system/contracts/button.variants"));
  assert.ok(!button.includes("--grad-brand"), "no brand gradient: the DS primary is a flat fill");
  for (const name of ["Badge", "Card"]) {
    const src = read(`../../src/shared/components/${name}.tsx`);
    assert.ok(
      src.includes(`design-system/contracts/${name.toLowerCase()}.variants`),
      `${name} adopts its DS contract`
    );
  }
});

test("Modal keeps the card radius; Input / Select adopt their DS contracts", () => {
  const modal = read("../../src/shared/components/Modal.tsx");
  const input = read("../../src/shared/components/Input.tsx");
  const select = read("../../src/shared/components/Select.tsx");
  assert.ok(modal.includes("rounded-card"), "modal uses rounded-card");
  assert.ok(input.includes("design-system/contracts/input.variants"), "input uses the DS contract");
  assert.ok(
    select.includes("design-system/contracts/select.variants"),
    "select uses the DS contract"
  );
});

// ── Phase 3 (partial): status hex centralized + mono font token ──

test("status colors come from one canonical module", () => {
  const mod = read("../../src/shared/constants/statusColors.ts");
  assert.match(mod, /export const STATUS_HEX/);
  assert.match(mod, /success:\s*"#22c55e"/);
  assert.match(mod, /warning:\s*"#f59e0b"/);
  assert.match(mod, /error:\s*"#ef4444"/);

  // Fase 3 (D1): the two shared flow surfaces moved from the fixed dark hex to the
  // theme-aware `--orch-status-*` tokens. STATUS_HEX stays exported as the dark-mode
  // mirror (and the canonical source of the token values in globals.css `.dark`).
  const edges = read("../../src/shared/components/flow/edgeStyles.ts");
  const badge = read("../../src/shared/components/TokenHealthBadge.tsx");
  assert.ok(
    edges.includes("var(--orch-status-success)"),
    "edgeStyles uses the success token, not a literal"
  );
  assert.ok(edges.includes("var(--orch-status-error)"), "edgeStyles uses the error token");
  assert.ok(edges.includes("var(--orch-status-warning)"), "edgeStyles uses the warning token");
  assert.ok(!edges.includes('"#22c55e"'), "edgeStyles no longer hardcodes the success hex");
  assert.ok(
    badge.includes("var(--orch-status-success)"),
    "TokenHealthBadge uses the success token"
  );
  assert.ok(badge.includes("var(--orch-status-error)"), "TokenHealthBadge uses the error token");
  assert.ok(
    badge.includes("var(--orch-status-warning)"),
    "TokenHealthBadge uses the warning token"
  );
  assert.ok(!badge.includes('"#22c55e"'), "TokenHealthBadge no longer hardcodes the success hex");

  // The adapter follows DS Color Scheme roles instead of duplicating dark/light literals.
  for (const token of ["success", "warning", "error", "muted"]) {
    assert.match(bridgeCss, new RegExp(`--orch-status-${token}:\\s*var\\(`));
  }
  for (const scheme of ["light", "dark"]) {
    const css = read(`../../src/shared/design-system/vendor/theme/scheme-${scheme}.css`);
    for (const role of ["success", "warning", "danger"]) {
      assert.ok(css.includes(`--reddb-color-feedback-${role}-foreground:`));
    }
  }
});

// ── Phase 3 (D2): the remaining flow surfaces read the status tokens ──

test("flow surfaces express state with --orch-status-* tokens, not fixed hex", () => {
  // Every state-bearing color on the four flow surfaces (home topology, combo live
  // studio, compression cockpit/waterfall, compression nodes) must be a theme-aware
  // token. Decorative/categorical palettes (STRATEGY_COLORS, LAYER_COLORS, the
  // provider brand color, the input/output identity pair) legitimately stay hex and
  // are asserted below so a future migration does not silently swallow them.
  const combo = read("../../src/app/(dashboard)/dashboard/combos/live/ComboLiveStudio.tsx");
  const engine = read(
    "../../src/app/(dashboard)/dashboard/compression/studio/nodes/EngineNode.tsx"
  );
  const waterfall = read(
    "../../src/app/(dashboard)/dashboard/compression/studio/WaterfallInspector.tsx"
  );
  const cockpit = read(
    "../../src/app/(dashboard)/dashboard/compression/studio/CompressionCockpit.tsx"
  );
  const io = read("../../src/app/(dashboard)/dashboard/compression/studio/nodes/IoNode.tsx");

  // Combo live studio: active/error provider pills + the run outcome tri-state.
  assert.ok(combo.includes("FLOW_EDGE_COLORS.active"), "combo active pill uses the flow palette");
  assert.ok(combo.includes("FLOW_EDGE_COLORS.error"), "combo error pill uses the flow palette");
  assert.ok(
    combo.includes('"var(--orch-status-success)"'),
    "combo outcome succeeded = success token"
  );
  assert.ok(combo.includes('"var(--orch-status-error)"'), "combo outcome exhausted = error token");
  assert.ok(
    combo.includes('"var(--orch-status-warning)"'),
    "combo outcome pending = warning token"
  );
  assert.ok(!combo.includes('"#22c55e"'), "combo studio hardcodes no success hex");
  assert.ok(!combo.includes('"#ef4444"'), "combo studio hardcodes no error hex");
  assert.ok(!combo.includes('"#f59e0b"'), "combo studio hardcodes no warning hex");

  // Compression engine node: savings ramp + the running state.
  assert.ok(engine.includes('"var(--orch-status-success)"'), "engine savings>=30 = success token");
  assert.ok(
    engine.includes('"var(--orch-status-warning)"'),
    "engine savings>=15 / running = warning token"
  );
  assert.ok(engine.includes('"var(--orch-status-muted)"'), "engine no-savings = muted token");
  assert.ok(
    engine.includes("flowColorAlpha("),
    "engine glow uses color-mix, not a hex alpha suffix"
  );
  assert.ok(!engine.includes('"#f59e0b"'), "engine hardcodes no warning hex");
  assert.ok(!engine.includes("#f59e0b40"), "the 8-bit alpha suffix is gone (invalid on a var())");

  // Waterfall inspector: same ramp + the skipped/idle state + the total savings.
  assert.ok(waterfall.includes('"var(--orch-status-success)"'), "waterfall success token");
  assert.ok(waterfall.includes('"var(--orch-status-warning)"'), "waterfall warning token");
  assert.ok(waterfall.includes('"var(--orch-status-muted)"'), "waterfall skipped = muted token");
  assert.ok(!waterfall.includes('"#22c55e"'), "waterfall hardcodes no success hex");
  assert.ok(!waterfall.includes('"#6b7280"'), "waterfall hardcodes no muted hex");

  // Cockpit header + IoNode savings readout.
  assert.ok(cockpit.includes('"var(--orch-status-success)"'), "cockpit savings = success token");
  assert.ok(!cockpit.includes('"#22c55e"'), "cockpit hardcodes no success hex");
  assert.ok(io.includes('"var(--orch-status-success)"'), "IoNode savings = success token");

  // Deliberately NOT migrated — categorical/brand palettes, not state.
  const strategy = read("../../src/app/(dashboard)/dashboard/combos/live/nodes/StrategyNode.tsx");
  assert.ok(strategy.includes("STRATEGY_COLORS"), "strategy hues stay a categorical palette");
  assert.ok(engine.includes("LAYER_COLORS"), "layer pills stay a categorical palette");
  assert.ok(
    io.includes('isInput ? "#6366f1" : "#22c55e"'),
    "IoNode keeps its indigo/green input-output identity pair"
  );
});

test("globals.css uses the canonical self-hosted monospace family", () => {
  assert.match(globalsCss, /--font-mono:\s*var\(--reddb-font-family-mono\)/);
});

test("DataTable stays theme-aware through canonical DS roles and its existing token API", () => {
  assert.match(bridgeCss, /--table-header-bg:\s*var\(--reddb-color-elevation-raised-surface\)/);
  assert.match(
    bridgeCss,
    /--table-row-zebra:\s*color-mix\(in srgb, var\(--reddb-color-foreground\) 2%, transparent\)/
  );
  assert.match(
    bridgeCss,
    /--table-row-hover:\s*color-mix\(in srgb, var\(--reddb-color-foreground\) 8%, transparent\)/
  );
  assert.match(bridgeCss, /--table-cell-border:\s*var\(--reddb-color-elevation-base-border\)/);

  const dt = read("../../src/shared/components/DataTable.tsx");
  assert.ok(dt.includes("var(--table-header-bg)"), "header uses the token");
  assert.ok(dt.includes("var(--table-row-zebra)"), "zebra uses the token");
  assert.ok(dt.includes("var(--color-border)"), "header border uses the brand token");
  assert.ok(
    !/rgba\(|#[0-9a-fA-F]{3,6}/.test(dt),
    "DataTable no longer hardcodes any color literal"
  );
  assert.ok(
    !dt.includes("--text-secondary") && !dt.includes("--bg-table-header"),
    "the dead var fallbacks are gone"
  );
});

// ── Phase 4 (safe additives): cn() merge + Checkbox / Textarea primitives ──

test("cn() dedupes conflicting Tailwind classes via tailwind-merge", () => {
  const cnSrc = read("../../src/shared/utils/cn.ts");
  assert.match(cnSrc, /from "tailwind-merge"/);
  assert.match(cnSrc, /from "clsx"/);
  assert.match(cnSrc, /twMerge\(clsx\(/);
});

test("Checkbox + Textarea primitives exist and are exported", () => {
  const barrel = read("../../src/shared/components/index.tsx");
  assert.ok(barrel.includes('export { default as Checkbox } from "./Checkbox"'));
  assert.ok(barrel.includes('export { default as Textarea } from "./Textarea"'));
  const checkbox = read("../../src/shared/components/Checkbox.tsx");
  const textarea = read("../../src/shared/components/Textarea.tsx");
  assert.ok(
    checkbox.includes("accent-[var(--color-accent)]"),
    "checkbox uses the brand accent token"
  );
  assert.ok(textarea.includes("rounded-control"), "textarea uses the control radius");
});

// ── C6: form controls share one accent focus ring (separate from the red error state) ──

test("form controls focus on the accent ring, not the red primary", () => {
  // The global :focus-visible ring already uses --color-accent. Align the form
  // controls to it so keyboard focus is one consistent violet everywhere and the
  // red focus ring no longer collides with the red error state.
  assert.match(globalsCss, /--focus-ring:.*var\(--color-accent\)/);
  // Input and Select take their focus ring from the DS contracts (ring-primary).
  for (const name of ["Textarea", "Toggle", "Checkbox"]) {
    const src = read(`../../src/shared/components/${name}.tsx`);
    assert.ok(/ring-accent\/30/.test(src), `${name} uses the accent focus ring`);
    assert.ok(
      !/(?:focus|focus-visible):ring-primary\/30/.test(src),
      `${name} no longer uses the red primary focus ring`
    );
    // the red error ring stays intact where the control has an error state
    if (src.includes("error")) {
      assert.ok(src.includes("ring-red-500/20"), `${name} keeps the red error ring`);
    }
  }
});

// ── Phase 5: the grid reaches every standalone screen + the shell is fluid up to 4K ──

test("standalone full-screen pages stay transparent so the grid shows through", () => {
  // Same contract as the DashboardLayout shell: a full-viewport wrapper must not paint
  // an opaque bg-bg over the body::before grid. These are the auth / error / legal /
  // status / onboarding screens that render outside the dashboard layout — the ones the
  // first grid phase missed. (?![\w-]) keeps bg-bg-alt / bg-bg-main from matching.
  const pages = [
    "../../src/app/login/page.tsx",
    "../../src/app/forgot-password/page.tsx",
    "../../src/app/callback/page.tsx",
    "../../src/app/maintenance/page.tsx",
    "../../src/app/offline/page.tsx",
    "../../src/app/status/page.tsx",
    "../../src/app/terms/page.tsx",
    "../../src/app/privacy/page.tsx",
    "../../src/app/(dashboard)/dashboard/onboarding/page.tsx",
    "../../src/shared/components/ErrorPageScaffold.tsx",
  ];
  for (const p of pages) {
    const src = read(p);
    assert.ok(
      !/min-h-screen[^"]*\bbg-bg(?![\w-])/.test(src) &&
        !/\bbg-bg(?![\w-])[^"]*min-h-screen/.test(src),
      `${p} must not paint bg-bg on a min-h-screen wrapper (it would hide the grid)`
    );
  }
});

test("DashboardLayout content shell is fluid up to ~4K before centering", () => {
  // The inner content wrapper grows with the viewport up to a 4K cap (3840px) instead
  // of the old max-w-7xl (1280px) that left wide side gutters on large monitors.
  assert.ok(
    dashboardLayout.includes("max-w-[3840px] mx-auto"),
    "content wrapper caps at 3840px (4K) and centers only beyond that"
  );
  assert.ok(!dashboardLayout.includes("max-w-7xl"), "the old 1280px max-w-7xl cap is gone");
});

// ── Phase 6: data tables are opaque content surfaces so the grid never bleeds through ──
//
// The dashboard content area is intentionally transparent (the body::before grid shows
// through as a wallpaper). A data table whose nearest ancestor is NOT an opaque surface
// would let the grid bleed through its transparent even-rows / low-alpha zebra rows.
// Cards already carry bg-surface; these guards cover the shared table primitives and the
// tables that render *without* a Card. Tables verified to live inside a <Card>/Modal are
// intentionally left untouched (bg-surface there would be a redundant no-op).

test("DataTable primitive paints its own opaque surface", () => {
  const dt = read("../../src/shared/components/DataTable.tsx");
  assert.ok(
    dt.includes("var(--color-surface)"),
    "DataTable scroll container is opaque (its even rows are transparent by design)"
  );
});

test("log table cards are opaque (no semi-transparent bg-black tint)", () => {
  // bg-black/5|20 on a <Card> wins over the Card's own bg-surface via tailwind-merge,
  // turning the big log tables ~95% transparent — the grid bled straight through them.
  for (const p of [
    "../../src/shared/components/ProxyLogger.tsx",
    "../../src/shared/components/RequestLoggerV2.tsx",
  ]) {
    const src = read(p);
    assert.ok(
      !src.includes("bg-black/5") && !src.includes("bg-black/20"),
      `${p} must not tint the table Card with bg-black/5|20 (it drops the Card's opaque surface)`
    );
    assert.ok(src.includes("bg-surface"), `${p} table card uses the opaque bg-surface`);
  }
});

test("card-less data tables wrap their table in an opaque surface", () => {
  const expect = [
    [
      "../../src/app/(dashboard)/dashboard/batch/BatchListTab.tsx",
      "rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]",
    ],
    [
      "../../src/app/(dashboard)/dashboard/batch/FilesListTab.tsx",
      "rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]",
    ],
    [
      "../../src/app/(dashboard)/dashboard/cache/components/CacheEntriesTab.tsx",
      "overflow-x-auto bg-surface",
    ],
    [
      "../../src/app/(dashboard)/dashboard/settings/components/proxy/FreePoolTab.tsx",
      "rounded border border-border bg-surface",
    ],
    [
      "../../src/app/(dashboard)/dashboard/tools/agent-bridge/components/ModelMappingTable.tsx",
      "overflow-hidden bg-surface",
    ],
    [
      "../../src/app/(dashboard)/dashboard/tools/traffic-inspector/components/shared/HeaderTable.tsx",
      "bg-surface",
    ],
  ];
  for (const [p, needle] of expect) {
    const src = read(p);
    assert.ok(
      src.includes(needle),
      `${p} must include "${needle}" so the table is opaque over the grid`
    );
  }
});

test("semi-transparent cache table boxes are now opaque", () => {
  for (const p of [
    "../../src/app/(dashboard)/dashboard/cache/components/ReasoningCacheTab.tsx",
    "../../src/app/(dashboard)/dashboard/cache/page.tsx",
  ]) {
    const src = read(p);
    assert.ok(
      !src.includes("bg-surface/35"),
      `${p} table box no longer uses the ~35%-opaque bg-surface/35 (the grid bled through it)`
    );
  }
});
