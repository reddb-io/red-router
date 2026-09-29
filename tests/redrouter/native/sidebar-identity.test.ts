import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const sidebar = readFileSync(
  new URL("../../../src/shared/components/Sidebar.tsx", import.meta.url),
  "utf8"
);

test("the sidebar navigation renders through the design system's nav item contract", () => {
  assert.ok(sidebar.includes("design-system/contracts/nav-item.variants"));
  assert.ok(sidebar.includes("navItem({ active })"));
  // The old selection language was a tinted red fill.
  assert.equal(sidebar.includes("bg-primary/10 text-primary"), false);
});

test("the sidebar carries no OmniRoute chrome", () => {
  assert.equal(sidebar.includes("OmniRouteLogo"), false);
  // Decorative macOS window-control dots and the gradient logo tile are gone.
  for (const colour of ["#FF5F56", "#FFBD2E", "#27C93F", "from-[#E54D5E]"]) {
    assert.equal(sidebar.includes(colour), false, colour);
  }
});
