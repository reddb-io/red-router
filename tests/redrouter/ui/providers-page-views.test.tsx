// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/i18n/messages/en.json";

const translators = new Map<string, (key: string, values?: Record<string, unknown>) => string>();
vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    let translate = translators.get(namespace);
    if (!translate) {
      translate = (key, values) => {
        const template = (messages as Record<string, Record<string, string>>)[namespace]?.[key];
        if (typeof template !== "string") return `${namespace}.${key}`;
        return template.replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? ""));
      };
      translators.set(namespace, translate);
    }
    return translate;
  },
}));

const push = vi.fn();
// Stable identities, like the real hooks: the URL filter hook re-hydrates when `searchParams` changes.
const routerStub = { push };
const searchParamsStub = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => routerStub,
  useSearchParams: () => searchParamsStub,
}));
vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/shared/components/ProviderIcon", () => ({ default: () => null }));
vi.mock("@/shared/components/ProviderTestSlideOver", () => ({ default: () => null }));

import ProvidersPage from "@/app/(dashboard)/dashboard/providers/page";
import { PROVIDER_VIEW_STORAGE_KEY } from "@/app/(dashboard)/dashboard/providers/providerPageStorage";

const availability = {
  openai: { enabled: true, kind: "connected" },
  aihorde: { enabled: true, kind: "free-optin" },
  uncloseai: { enabled: false, kind: "available" },
  "veoaifree-web": { enabled: false, kind: "available" },
  anthropic: { enabled: false, kind: "available" },
};

let root: Root | null = null;
let container: HTMLElement;
let connections: Record<string, unknown>[];
let currentAvailability: Record<string, unknown>;

function respond(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

beforeEach(() => {
  window.localStorage.clear();
  push.mockClear();
  connections = [{ id: "c1", provider: "openai", authType: "apikey", name: "key", isActive: true }];
  currentAvailability = availability;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url === "/api/providers")
        return respond({ connections, providerAvailability: currentAvailability });
      if (url === "/api/provider-nodes") return respond({ nodes: [] });
      if (url === "/api/providers/free-sources") {
        return respond({
          providers: [
            {
              id: "aihorde",
              name: "AI Horde",
              alias: "aihorde",
              enabled: true,
              hasConnection: false,
              kind: "free-optin",
            },
            {
              id: "uncloseai",
              name: "UncloseAI",
              alias: "uncloseai",
              enabled: false,
              hasConnection: false,
              kind: "available",
            },
          ],
          legacyUsage: [],
        });
      }
      if (url === "/api/system/env/repair") return respond({ available: false, missingCount: 0 });
      return respond({});
    })
  );
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  root = createRoot(container);
  await act(async () => {
    root!.render(<ProvidersPage />);
  });
  // Let the parallel first-paint requests settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const tab = (view: string) =>
  container.querySelector(`[data-testid="provider-view-${view}"]`) as HTMLElement;
const cardIds = () =>
  [...container.querySelectorAll('[id^="provider-"]:not([id^="provider-view"])')].map((el) =>
    el.id.replace("provider-", "")
  );

describe("providers page views", () => {
  it("opens on Enabled and lists only what is enabled", async () => {
    await render();
    expect(tab("enabled").getAttribute("aria-selected")).toBe("true");
    const ids = cardIds();
    expect(ids).toContain("openai");
    expect(ids).toContain("aihorde");
    // Known but not enabled: never in the default view.
    expect(ids).not.toContain("uncloseai");
    expect(ids).not.toContain("veoaifree-web");
    expect(ids).not.toContain("anthropic");
  });

  it("hides categories that have nothing enabled", async () => {
    await render();
    const headings = [...container.querySelectorAll("h2")].map((h) => h.textContent ?? "");
    expect(headings.some((h) => h.includes(messages.providers.oauthProviders))).toBe(false);
    expect(headings.some((h) => h.includes(messages.providers.searchProvidersHeading))).toBe(false);
  });

  it("compact mode applies the same rule", async () => {
    // Switch to the flat compact layout through the page's own display-mode control.
    await render();
    const compactRadio = container.querySelector(
      '[data-testid="provider-display-mode-compact"] input'
    ) as HTMLInputElement;
    await act(async () => compactRadio.click());
    const grid = container.querySelector('[data-testid="provider-compact-grid"]');
    expect(grid).toBeTruthy();
    const ids = [...grid!.querySelectorAll('[id^="provider-"]')].map((el) =>
      el.id.replace("provider-", "")
    );
    expect(ids).toEqual(expect.arrayContaining(["openai", "aihorde"]));
    expect(ids).not.toContain("uncloseai");
    expect(ids).not.toContain("veoaifree-web");
  });

  it("shows the empty state, not a catalogue, when nothing is enabled", async () => {
    connections = [];
    currentAvailability = {};
    await render();
    expect(cardIds()).toEqual([]);
    expect(container.textContent).toContain("Nothing is enabled yet");
    await act(async () =>
      (container.querySelector('[data-testid="provider-hint-free-sources"]') as HTMLElement).click()
    );
    expect(tab("free").getAttribute("aria-selected")).toBe("true");
  });

  it("switches to Free sources, and remembers the choice", async () => {
    await render();
    await act(async () => tab("free").click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.querySelector('[data-testid="free-sources-panel"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="free-source-uncloseai"]')).toBeTruthy();
    expect(window.localStorage.getItem(PROVIDER_VIEW_STORAGE_KEY)).toBe("free");
  });

  it("restores the stored view on the next visit and ignores a corrupt one", async () => {
    window.localStorage.setItem(PROVIDER_VIEW_STORAGE_KEY, "all");
    await render();
    expect(tab("all").getAttribute("aria-selected")).toBe("true");
    await act(async () => root?.unmount());
    root = null;

    window.localStorage.setItem(PROVIDER_VIEW_STORAGE_KEY, "{corrupt");
    await render();
    expect(tab("enabled").getAttribute("aria-selected")).toBe("true");
  });

  it("All providers lists the catalogue with an Add action that opens the provider page", async () => {
    await render();
    await act(async () => tab("all").click());
    expect(container.querySelector('[data-testid="provider-catalogue"]')).toBeTruthy();
    expect(
      container.querySelector('[data-testid="provider-catalogue-row-uncloseai"]')
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="provider-catalogue-row-anthropic"]')
    ).toBeTruthy();
    const add = container.querySelector('[aria-label="Add UncloseAI"]') as HTMLElement;
    await act(async () => add.click());
    expect(push).toHaveBeenCalledWith("/dashboard/providers/uncloseai");
  });
});
