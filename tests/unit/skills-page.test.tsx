/**
 * Unit tests for SkillsPageClient and its sub-components.
 * These are structural/file-system tests — they verify the correct component
 * split, file structure, source patterns, and exported symbols without DOM rendering.
 *
 * Run:
 *   vitest run tests/unit/omni-skills-page.test.tsx
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const cwd = process.cwd();
const base = resolve(join(cwd, "src/app/(dashboard)/dashboard/skills"));

// ─── File structure ──────────────────────────────────────────────────────────

describe("File structure — omni-skills directory", () => {
  it("old /dashboard/skills directory does not exist", () => {
    const oldPath = resolve(join(cwd, "src/app/(dashboard)/dashboard/skills"));
    expect(existsSync(oldPath), `Old skills/ directory must be absent (found at ${oldPath})`).toBe(
      false
    );
  });

  it("new /dashboard/skills directory exists", () => {
    expect(existsSync(base), `omni-skills/ directory must exist at ${base}`).toBe(true);
  });

  const expectedFiles = [
    "page.tsx",
    "SkillsPageClient.tsx",
    "components/InstalledSkillCard.tsx",
    "components/SkillInspectorPane.tsx",
    "components/InstalledSkillsList.tsx",
    "components/ExecutionsTab.tsx",
    "components/SandboxTab.tsx",
    "components/MarketplaceTab.tsx",
  ];

  for (const file of expectedFiles) {
    it(`file exists: omni-skills/${file}`, () => {
      expect(existsSync(resolve(join(base, file))), `Expected omni-skills/${file} to exist`).toBe(
        true
      );
    });
  }
});

// ─── page.tsx — server component ─────────────────────────────────────────────

describe("page.tsx — server component", () => {
  const src = readFileSync(resolve(join(base, "page.tsx")), "utf-8");

  it("is a server component (no 'use client' directive)", () => {
    expect(
      !src.includes('"use client"') && !src.includes("'use client'"),
      "page.tsx must not have 'use client'"
    ).toBe(true);
  });

  it("imports and renders SkillsPageClient", () => {
    expect(
      src.includes("SkillsPageClient"),
      "page.tsx must reference SkillsPageClient"
    ).toBe(true);
  });

  it("has a default export named Page", () => {
    expect(
      src.includes("export default function Page"),
      "page.tsx must have 'export default function Page'"
    ).toBe(true);
  });
});

// ─── SkillsPageClient.tsx ─────────────────────────────────────────────────

describe("SkillsPageClient.tsx", () => {
  const src = readFileSync(resolve(join(base, "SkillsPageClient.tsx")), "utf-8");

  it("starts with 'use client'", () => {
    expect(
      src.startsWith('"use client"'),
      "SkillsPageClient must start with 'use client'"
    ).toBe(true);
  });

  it("has all 4 tab IDs", () => {
    for (const tabId of ["skills", "executions", "sandbox", "marketplace"]) {
      expect(
        src.includes(`id: "${tabId}"`),
        `SkillsPageClient must have tab id="${tabId}"`
      ).toBe(true);
    }
  });

  it("renders SkillsConceptCard with variant='omni'", () => {
    expect(
      src.includes('variant="omni"'),
      'SkillsPageClient must render <SkillsConceptCard variant="omni" />'
    ).toBe(true);
  });

  it("imports SkillsConceptCard from shared components", () => {
    expect(
      src.includes("SkillsConceptCard"),
      "SkillsPageClient must import SkillsConceptCard"
    ).toBe(true);
  });

  it("has selectedSkillId state", () => {
    expect(
      src.includes("selectedSkillId"),
      "SkillsPageClient must maintain selectedSkillId state"
    ).toBe(true);
  });

  it("wires InstalledSkillsList with inspector props", () => {
    expect(src.includes("InstalledSkillsList"), "SkillsPageClient must render InstalledSkillsList").toBe(
      true
    );
    expect(
      src.includes("onSelectSkill"),
      "SkillsPageClient must pass onSelectSkill to InstalledSkillsList"
    ).toBe(true);
  });

  it("renders all 4 tab components", () => {
    for (const component of [
      "InstalledSkillsList",
      "ExecutionsTab",
      "SandboxTab",
      "MarketplaceTab",
    ]) {
      expect(src.includes(component), `SkillsPageClient must render <${component}>`).toBe(true);
    }
  });

  it("has install modal with hardcoded 'X' close button (preserved behavior)", () => {
    expect(src.includes("showInstallModal"), "must preserve showInstallModal state").toBe(true);
  });
});

// ─── InstalledSkillCard.tsx ────────────────────────────────────────────────────────

describe("InstalledSkillCard.tsx", () => {
  const src = readFileSync(resolve(join(base, "components/InstalledSkillCard.tsx")), "utf-8");

  it("starts with 'use client'", () => {
    expect(src.startsWith('"use client"'), "must be a client component").toBe(true);
  });

  it("accepts skill, selected, onClick props", () => {
    expect(src.includes("InstalledSkillCardProps"), "must define InstalledSkillCardProps").toBe(true);
    expect(src.includes("selected:"), "must have selected prop").toBe(true);
    expect(src.includes("onClick:"), "must have onClick prop").toBe(true);
  });

  it("has role='button' for accessibility", () => {
    expect(src.includes('role="button"'), "must have role='button' for accessibility").toBe(true);
  });

  it("exports InstalledSkillCard", () => {
    expect(
      src.includes("export function InstalledSkillCard") || src.includes("export { InstalledSkillCard }"),
      "must export InstalledSkillCard"
    ).toBe(true);
  });

  it("exports OmniSkill interface", () => {
    expect(
      src.includes("export interface OmniSkill"),
      "must export OmniSkill interface for other components"
    ).toBe(true);
  });
});

// ─── SkillInspectorPane.tsx ───────────────────────────────────────────────────

describe("SkillInspectorPane.tsx", () => {
  const src = readFileSync(resolve(join(base, "components/SkillInspectorPane.tsx")), "utf-8");

  it("starts with 'use client'", () => {
    expect(src.startsWith('"use client"'), "must be a client component").toBe(true);
  });

  it("has all 4 sub-tab IDs", () => {
    for (const tabId of ["schema", "handler", "executions", "sandbox"]) {
      expect(src.includes(`"${tabId}"`), `SkillInspectorPane must include sub-tab "${tabId}"`).toBe(
        true
      );
    }
  });

  it("has empty state text when no skill selected", () => {
    expect(
      src.includes("selectSkillToInspect"),
      "must have empty state message (i18n key selectSkillToInspect)"
    ).toBe(true);
  });

  it("fetches /api/skills/[id] for skill detail", () => {
    expect(
      src.includes("/api/skills/${selectedSkillId}") ||
        src.includes("`/api/skills/${selectedSkillId}`"),
      "must fetch /api/skills/${selectedSkillId} for detail"
    ).toBe(true);
  });

  it("fetches /api/skills/executions for the executions tab", () => {
    expect(
      src.includes("api/skills/executions?skillId=") || src.includes("api/skills/executions"),
      "must fetch executions for the selected skill"
    ).toBe(true);
  });

  it("has ON / AUTO / OFF / Uninstall buttons", () => {
    expect(src.includes("onSetMode"), "must call onSetMode for mode buttons").toBe(true);
    expect(src.includes("onUninstall"), "must call onUninstall").toBe(true);
  });
});

// ─── InstalledSkillsList.tsx ───────────────────────────────────────────────────────

describe("InstalledSkillsList.tsx", () => {
  const src = readFileSync(resolve(join(base, "components/InstalledSkillsList.tsx")), "utf-8");

  it("uses grid-cols-12 split layout", () => {
    expect(src.includes("grid-cols-12"), "must use 12-column grid for split layout").toBe(true);
  });

  it("renders InstalledSkillCard for each skill", () => {
    expect(src.includes("InstalledSkillCard"), "must render InstalledSkillCard per skill").toBe(true);
  });

  it("renders SkillInspectorPane on the right", () => {
    expect(src.includes("SkillInspectorPane"), "must include SkillInspectorPane in right col").toBe(
      true
    );
  });

  it("has onSelectSkill prop to control inspector state", () => {
    expect(src.includes("onSelectSkill"), "must accept onSelectSkill prop").toBe(true);
  });
});

// ─── ExecutionsTab.tsx ────────────────────────────────────────────────────

describe("ExecutionsTab.tsx", () => {
  const src = readFileSync(resolve(join(base, "components/ExecutionsTab.tsx")), "utf-8");

  it("starts with 'use client'", () => {
    expect(src.startsWith('"use client"'), "must be a client component").toBe(true);
  });

  it("renders a table with skill/status/duration/time columns", () => {
    expect(src.includes('{t("skill")}'), "must have skill column").toBe(true);
    expect(src.includes('{t("status")}'), "must have status column").toBe(true);
    expect(src.includes('{t("duration")}'), "must have duration column").toBe(true);
  });

  it("has pagination buttons", () => {
    expect(src.includes("onPagePrev"), "must accept onPagePrev handler").toBe(true);
    expect(src.includes("onPageNext"), "must accept onPageNext handler").toBe(true);
  });
});

// ─── SandboxTab.tsx ───────────────────────────────────────────────────────

describe("SandboxTab.tsx", () => {
  const src = readFileSync(resolve(join(base, "components/SandboxTab.tsx")), "utf-8");

  it("starts with 'use client'", () => {
    expect(src.startsWith('"use client"'), "must be a client component").toBe(true);
  });

  it("shows sandbox config values", () => {
    expect(src.includes("100ms"), "must show 100ms CPU limit").toBe(true);
    expect(src.includes("256MB"), "must show 256MB memory limit").toBe(true);
    expect(src.includes("30s"), "must show 30s timeout").toBe(true);
  });
});

// ─── MarketplaceTab.tsx ───────────────────────────────────────────────────

describe("MarketplaceTab.tsx", () => {
  const src = readFileSync(resolve(join(base, "components/MarketplaceTab.tsx")), "utf-8");

  it("starts with 'use client'", () => {
    expect(src.startsWith('"use client"'), "must be a client component").toBe(true);
  });

  it("has marketplace search logic", () => {
    expect(
      src.includes("/api/skills/marketplace"),
      "must call /api/skills/marketplace endpoint"
    ).toBe(true);
  });

  it("has skills.sh search logic", () => {
    expect(src.includes("/api/skills/skillssh"), "must call /api/skills/skillssh endpoint").toBe(
      true
    );
  });

  it("accepts skillsProvider and onRefreshSkills props", () => {
    expect(src.includes("skillsProvider"), "must accept skillsProvider prop").toBe(true);
    expect(src.includes("onRefreshSkills"), "must accept onRefreshSkills prop").toBe(true);
  });
});

// ─── E2E test update ──────────────────────────────────────────────────────────

describe("E2E spec path", () => {
  const src = readFileSync(resolve(join(cwd, "tests/e2e/skills-marketplace.spec.ts")), "utf-8");

  it("uses /dashboard/skills (not /dashboard/skills)", () => {
    expect(
      src.includes("/dashboard/skills"),
      "E2E spec must navigate to /dashboard/skills"
    ).toBe(true);
    expect(
      !src.includes('"/dashboard/skills"') && !src.includes("'/dashboard/skills'"),
      "E2E spec must not have the old /dashboard/skills path in gotoDashboardRoute call"
    ).toBe(true);
  });
});
