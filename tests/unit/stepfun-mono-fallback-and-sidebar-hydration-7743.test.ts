import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Regression guards for PR #7743:
//  1) @lobehub/icons v5.13+ dropped the Stepfun `Color` sub-component. Importing it
//     causes a build-time module-not-found error that breaks the whole dashboard.
//     Lock in the Mono fallback so a future bump can't silently re-import it.
//  2) DashboardLayout must not read localStorage synchronously during the initial
//     `useState` render — that produces a client/server markup mismatch (hydration
//     error) because the server always renders the `false` (collapsed=false) branch.
//     The fix defers the localStorage read to a `useEffect`.

const lobeProviderIconsSrc = fs.readFileSync(
  new URL("../../src/shared/components/lobeProviderIcons.ts", import.meta.url),
  "utf8"
);

const dashboardLayoutSrc = fs.readFileSync(
  new URL("../../src/shared/components/layouts/DashboardLayout.tsx", import.meta.url),
  "utf8"
);

test("lobeProviderIcons never imports the removed Stepfun Color sub-component", () => {
  assert.doesNotMatch(
    lobeProviderIconsSrc,
    /@lobehub\/icons\/es\/Stepfun\/components\/Color/,
    "Stepfun/components/Color does not exist in @lobehub/icons v5.13+ and must not be imported"
  );
});

test("lobeProviderIcons maps both Stepfun mono and color slots to StepfunMonoIcon", () => {
  const stepfunEntry = lobeProviderIconsSrc.match(
    /Stepfun:\s*{\s*mono:\s*(\w+),\s*color:\s*(\w+)\s*}/
  );
  assert.ok(stepfunEntry, "Stepfun entry must exist in LOBE_ICON_COMPONENTS");
  const [, mono, color] = stepfunEntry;
  assert.equal(mono, "StepfunMonoIcon");
  assert.equal(color, "StepfunMonoIcon", "color slot must fall back to the Mono icon");
});

test("the sidebar's stored state is read without a hydration mismatch", () => {
  // The panel width and open state come from useSyncExternalStore with a constant server snapshot,
  // so the server render and the first client render agree; DashboardLayout itself reads nothing.
  const hookSrc = fs.readFileSync(
    new URL("../../src/shared/hooks/useSidebarWidth.ts", import.meta.url),
    "utf8"
  );
  assert.match(hookSrc, /useSyncExternalStore\(\s*noopSubscribe,\s*readStored,\s*readServer\s*\)/);
  assert.match(
    hookSrc,
    /useSyncExternalStore\(\s*noopSubscribe,\s*readStoredOpen,\s*readServerOpen\s*\)/
  );
  assert.doesNotMatch(dashboardLayoutSrc, /localStorage\./);
});
