// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/i18n/messages/en.json";

// next-intl stub backed by the real English messages. Keys the page has no message for fall back
// to the panel's own English copy (providerText), exactly like the app when a key is absent.
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

import FreeSourcesPanel from "@/app/(dashboard)/dashboard/providers/components/FreeSourcesPanel";

type Source = {
  id: string;
  name: string;
  alias: string;
  enabled: boolean;
  hasConnection: boolean;
  kind: "connected" | "free-optin" | "available";
};

const source = (id: string, name: string, enabled = false): Source => ({
  id,
  name,
  alias: id,
  enabled,
  hasConnection: false,
  kind: enabled ? "free-optin" : "available",
});

let root: Root | null = null;
let container: HTMLElement;
let server: Source[];
let legacyUsage: string[];
let calls: { url: string; method: string; body?: { action: string; providerIds?: string[] } }[];
let failPosts: boolean;
let onChanged: ReturnType<typeof vi.fn>;

beforeEach(() => {
  calls = [];
  failPosts = false;
  legacyUsage = [];
  server = [
    source("aihorde", "AI Horde"),
    source("uncloseai", "UncloseAI"),
    source("veo-free", "Veo AI Free"),
  ];
  onChanged = vi.fn();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });
      if (method === "POST") {
        if (failPosts) return Promise.resolve(new Response("{}", { status: 500 }));
        const ids: string[] = body.providerIds ?? [];
        server = server.map((s) => {
          if (body.action === "enable-all") return { ...s, enabled: true };
          if (body.action === "disable-all") return { ...s, enabled: false };
          if (ids.includes(s.id)) return { ...s, enabled: body.action === "enable" };
          return s;
        });
        return Promise.resolve(
          new Response(JSON.stringify({ providers: server }), { status: 200 })
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ providers: server, legacyUsage })));
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
    root!.render(<FreeSourcesPanel onChanged={onChanged} />);
  });
}

const posts = () => calls.filter((call) => call.method === "POST");
// Buttons that carry an icon glyph also carry its ligature text, so match the accessible name.
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label || b.textContent === label
  ) as HTMLElement;
const switchFor = (name: string) =>
  container.querySelector(`[role="switch"][aria-label="Enable ${name}"]`) as HTMLElement;

describe("FreeSourcesPanel", () => {
  it("starts with nothing selected and says so", async () => {
    await render();
    const switches = [...container.querySelectorAll('[role="switch"]')];
    expect(switches).toHaveLength(3);
    expect(switches.every((el) => el.getAttribute("aria-checked") === "false")).toBe(true);
    expect(container.querySelector('[data-testid="free-sources-empty"]')?.textContent).toBe(
      "Nothing is enabled. Free sources are off until you turn them on."
    );
    expect(container.querySelector('[data-testid="free-sources-count"]')?.textContent).toBe(
      "0 of 3 enabled"
    );
    expect(posts()).toHaveLength(0);
    // Disable all has nothing to disable yet.
    expect((button("Disable all") as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists sources alphabetically by name", async () => {
    await render();
    const names = [
      ...container.querySelectorAll('[data-testid^="free-source-"] span.font-medium'),
    ].map((el) => el.textContent);
    expect(names).toEqual(["AI Horde", "UncloseAI", "Veo AI Free"]);
  });

  it("enables one source through POST, flips optimistically and tells the page", async () => {
    await render();
    await act(async () => switchFor("AI Horde").click());
    expect(posts()).toHaveLength(1);
    expect(posts()[0].url).toBe("/api/providers/free-sources");
    expect(posts()[0].body).toEqual({ action: "enable", providerIds: ["aihorde"] });
    expect(switchFor("AI Horde").getAttribute("aria-checked")).toBe("true");
    expect(switchFor("UncloseAI").getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector('[data-testid="free-sources-empty"]')).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);

    await act(async () => switchFor("AI Horde").click());
    expect(posts()[1].body).toEqual({ action: "disable", providerIds: ["aihorde"] });
    expect(switchFor("AI Horde").getAttribute("aria-checked")).toBe("false");
  });

  it("rolls the switch back and shows an error when the server refuses", async () => {
    await render();
    failPosts = true;
    await act(async () => switchFor("UncloseAI").click());
    expect(posts()).toHaveLength(1);
    expect(switchFor("UncloseAI").getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Nothing was changed");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("asks for confirmation before enabling every free source", async () => {
    await render();
    await act(async () => button("Enable all free sources").click());
    expect(posts()).toHaveLength(0);
    expect(document.body.textContent).toContain("Enable all free sources?");
    expect(document.body.textContent).toContain("routing can send requests to them");

    await act(async () => button("Enable all").click());
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toEqual({ action: "enable-all" });
    expect(
      [...container.querySelectorAll('[role="switch"]')].every(
        (el) => el.getAttribute("aria-checked") === "true"
      )
    ).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the confirmation is cancelled", async () => {
    await render();
    await act(async () => button("Enable all free sources").click());
    await act(async () => button("Cancel").click());
    expect(posts()).toHaveLength(0);
    expect(container.querySelector('[data-testid="free-sources-empty"]')).not.toBeNull();
  });

  it("disables everything in one call without a confirmation", async () => {
    server = server.map((s) => ({ ...s, enabled: true }));
    await render();
    expect(container.querySelector('[data-testid="free-sources-empty"]')).toBeNull();
    await act(async () => button("Disable all").click());
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toEqual({ action: "disable-all" });
    expect(
      [...container.querySelectorAll('[role="switch"]')].every(
        (el) => el.getAttribute("aria-checked") === "false"
      )
    ).toBe(true);
  });

  it("offers recently used sources and enables exactly the listed ids on request", async () => {
    legacyUsage = ["aihorde", "veo-free"];
    await render();
    const notice = container.querySelector('[data-testid="free-sources-legacy-notice"]');
    expect(notice?.textContent).toContain("last 90 days");
    expect(notice?.textContent).toContain("AI Horde, Veo AI Free");
    // Listing them never enables anything on its own.
    expect(posts()).toHaveLength(0);
    expect(switchFor("AI Horde").getAttribute("aria-checked")).toBe("false");

    await act(async () => button("Enable them").click());
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toEqual({ action: "enable", providerIds: ["aihorde", "veo-free"] });
    expect(switchFor("AI Horde").getAttribute("aria-checked")).toBe("true");
    expect(switchFor("Veo AI Free").getAttribute("aria-checked")).toBe("true");
    expect(switchFor("UncloseAI").getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector('[data-testid="free-sources-legacy-notice"]')).toBeNull();
  });

  it("filters the list with the search box", async () => {
    await render();
    const input = container.querySelector("input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "horde");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(switchFor("AI Horde")).toBeTruthy();
  });
});
