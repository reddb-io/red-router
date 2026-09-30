// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `providers.${key}`,
}));

import ProviderCatalogueList from "@/app/(dashboard)/dashboard/providers/components/ProviderCatalogueList";

const entry = (
  providerId: string,
  name: string,
  displayAuthType: "oauth" | "apikey" | "compatible" | "no-auth",
  total = 0
) => ({
  providerId,
  provider: { id: providerId, name },
  stats: { total },
  displayAuthType,
  toggleAuthType: displayAuthType === "compatible" ? ("apikey" as const) : displayAuthType,
});

let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
});

async function render(node: React.ReactElement) {
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

describe("ProviderCatalogueList", () => {
  it("shows category, auth type and state per row, with one Add action for what is not enabled", async () => {
    const onOpenProvider = vi.fn();
    await render(
      <ProviderCatalogueList
        entries={[
          entry("openai", "OpenAI", "apikey", 1),
          entry("anthropic", "Anthropic", "apikey", 0),
          entry("aihorde", "AI Horde", "no-auth", 0),
        ]}
        availability={{
          openai: { enabled: true, kind: "connected" },
          anthropic: { enabled: false, kind: "available" },
          aihorde: { enabled: false, kind: "available" },
        }}
        onOpenProvider={onOpenProvider}
      />
    );

    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("OpenAI");
    expect(rows[0].textContent).toContain("API key");
    expect(rows[0].textContent).toContain("Enabled");
    expect(rows[2].textContent).toContain("Free source");
    expect(rows[2].textContent).toContain("No key");
    expect(rows[2].textContent).toContain("Not enabled");

    // Enabled providers are managed, the rest are added; both open the provider's page.
    expect(container.querySelector('[aria-label="Manage OpenAI"]')).toBeTruthy();
    const add = container.querySelector('[aria-label="Add AI Horde"]') as HTMLElement;
    expect(add).toBeTruthy();
    await act(async () => add.click());
    expect(onOpenProvider).toHaveBeenCalledWith("aihorde");
  });

  it("uses one neutral style for every category and auth label", async () => {
    await render(
      <ProviderCatalogueList
        entries={[entry("claude", "Claude", "oauth"), entry("aihorde", "AI Horde", "no-auth")]}
        availability={{}}
        onOpenProvider={() => {}}
      />
    );
    const tags = [...container.querySelectorAll("tbody span.rounded.border")];
    expect(tags.length).toBeGreaterThanOrEqual(4);
    for (const tag of tags) {
      expect(tag.className).toContain("bg-muted");
      expect(tag.className).toContain("text-text-muted");
      expect(tag.className).not.toMatch(/(red|green|blue|amber|purple|emerald|sky)-\d/);
    }
  });

  it("says so when nothing matches", async () => {
    await render(
      <ProviderCatalogueList entries={[]} availability={{}} onOpenProvider={() => {}} />
    );
    expect(container.querySelector('[data-testid="provider-catalogue-empty"]')).toBeTruthy();
  });
});
