// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (k: string) => (ns ? `${ns}.${k}` : k),
}));

import ModelVisibilityCard from "@/app/(dashboard)/dashboard/settings/components/ModelVisibilityCard";
import {
  addItem,
  moveItem,
  removeItem,
  sameOrder,
  unlisted,
} from "@/app/(dashboard)/dashboard/settings/components/providerPriorityList";

type Call = { url: string; method: string; body?: Record<string, unknown> };

const PROVIDERS = [
  { id: "openai", name: "OpenAI", connections: 2 },
  { id: "groq", name: "Groq", connections: 1 },
  { id: "kiro", name: "Kiro", connections: 1 },
];

let root: Root | null = null;
let container: HTMLElement;
let calls: Call[];
let state: { transparent: boolean; providerPriority: string[]; delegated: boolean };
let failPut: boolean;
let instanceProfileId: string | null;
let localTransparent: boolean | null;
let localPriority: string[] | null;
const PROFILE = {
  id: "p",
  name: "Shared",
  transparent: false,
  providerPriority: ["groq"],
  attachments: 0,
};

const tenantRows = () => [
  {
    id: "red",
    slug: "red",
    name: "red",
    isDefault: true,
    ownerPin: { transparent: null, providerPriority: null },
    tenantChoice: { transparent: null, providerPriority: null },
    effective: {
      transparent: state.transparent,
      providerPriority: state.providerPriority,
      source: { transparent: "instance", providerPriority: "instance" },
    },
  },
  {
    id: "t-acme",
    slug: "acme",
    name: "Acme",
    isDefault: false,
    ownerPin: { transparent: null, providerPriority: null },
    tenantChoice: { transparent: null, providerPriority: null },
    effective: {
      transparent: state.transparent,
      providerPriority: state.providerPriority,
      source: { transparent: "instance", providerPriority: "instance" },
    },
  },
];

beforeEach(() => {
  calls = [];
  failPut = false;
  instanceProfileId = null;
  localTransparent = null;
  localPriority = null;
  state = { transparent: true, providerPriority: [], delegated: false };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (method === "GET") {
      return Response.json({
        policy: {
          ...state,
          profileId: instanceProfileId,
          local: {
            transparent: instanceProfileId ? localTransparent : state.transparent,
            providerPriority: instanceProfileId ? localPriority : state.providerPriority,
          },
          defaults: { transparent: state.transparent, providerPriority: state.providerPriority },
        },
        providers: PROVIDERS,
        tenants: tenantRows(),
        profiles: [PROFILE],
      });
    }
    if (failPut) return Response.json({ error: { message: "Nope" } }, { status: 400 });
    if (url === "/api/routing") {
      instanceProfileId = body.profileId ?? null;
      if (instanceProfileId) {
        localTransparent = body.transparent;
        localPriority = body.providerPriority;
      }
      state = {
        transparent: body.transparent ?? state.transparent,
        providerPriority: body.providerPriority ?? state.providerPriority,
        delegated: body.delegateToTenants ?? state.delegated,
      };
    }
    return Response.json({ ok: true });
  });
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container.remove();
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function mount() {
  root = createRoot(container);
  await act(async () => {
    root!.render(<ModelVisibilityCard />);
  });
  await act(async () => {});
}

const text = () => container.textContent ?? "";
const buttonByLabel = (label: string) =>
  container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
const buttonByText = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as
    HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("provider priority helpers", () => {
  it("moves, removes and adds without mutating", () => {
    const list = ["a", "b", "c"];
    expect(moveItem(list, 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(list, 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveItem(list, 0, -1)).toEqual(list);
    expect(moveItem(list, 2, 1)).toEqual(list);
    expect(removeItem(list, "b")).toEqual(["a", "c"]);
    expect(addItem(list, "d")).toEqual(["a", "b", "c", "d"]);
    expect(addItem(list, "a")).toEqual(list);
    expect(list).toEqual(["a", "b", "c"]);
  });

  it("lists what is not ordered yet, by name, and compares orders", () => {
    expect(unlisted(PROVIDERS, ["groq"]).map((p) => p.id)).toEqual(["kiro", "openai"]);
    expect(sameOrder(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameOrder(["a", "b"], ["b", "a"])).toBe(false);
  });
});

describe("ModelVisibilityCard", () => {
  it("loads the policy, starts transparent, and offers Save only after a change", async () => {
    await mount();
    expect(text()).toContain("Model visibility");
    expect(
      (container.querySelector('select[aria-label="Model visibility"]') as HTMLSelectElement | null)
        ?.value ?? container.querySelectorAll("select")[1].value
    ).toBe("on");
    expect(buttonByText("Save")!.disabled).toBe(true);
    expect(text()).toContain("Used when provider prefixes are hidden.");
  });

  it("turns transparency off, orders the providers, and saves everything in one request", async () => {
    await mount();
    await act(async () => {
      const select = container.querySelectorAll("select")[1];
      select.value = "off";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(text()).toContain("Unlisted providers follow in catalog order.");
    await click(buttonByLabel("Add Kiro to the order"));
    await click(buttonByLabel("Add OpenAI to the order"));
    await click(buttonByLabel("Move OpenAI up"));
    await click(buttonByText("Save"));
    const put = calls.find((c) => c.method === "PUT" && c.url === "/api/routing")!;
    expect(put.body).toEqual({
      profileId: null,
      transparent: false,
      providerPriority: ["openai", "kiro"],
      delegateToTenants: false,
    });
    expect(text()).toContain("Saved.");
    expect(buttonByText("Save")!.disabled).toBe(true);
  });

  it("removes a provider from the order", async () => {
    await mount();
    await click(buttonByLabel("Add Groq to the order"));
    expect(text()).toContain("Groq");
    await click(buttonByLabel("Remove Groq from the order"));
    expect(buttonByLabel("Add Groq to the order")).toBeTruthy();
  });

  it("delegating to tenants is its own switch and is saved", async () => {
    await mount();
    await click(container.querySelector('button[aria-label="Let tenant admins change this"]'));
    await click(buttonByText("Save"));
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ delegateToTenants: true });
  });

  it("shows why a save failed", async () => {
    await mount();
    await act(async () => {
      const select = container.querySelectorAll("select")[1];
      select.value = "off";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    failPut = true;
    await click(buttonByText("Save"));
    expect(text()).toContain("Nope");
  });

  it("pins a tenant: the owner's setting for it is what the request carries", async () => {
    await mount();
    expect(text()).toContain("Per tenant");
    const acme = [...container.querySelectorAll("div")].find(
      (d) => d.textContent?.includes("Save for Acme") && d.className.includes("rounded-md")
    )!;
    const select = acme.querySelectorAll("select")[1] as HTMLSelectElement;
    await act(async () => {
      select.value = "off";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(buttonByText("Save for Acme"));
    const put = calls.find((c) => c.url === "/api/tenants/t-acme/routing")!;
    expect(put.method).toBe("PUT");
    expect(put.body).toEqual({ profileId: null, transparent: false, priority: null });
  });

  it("pins a provider order for a tenant too", async () => {
    await mount();
    const acme = () =>
      [...container.querySelectorAll("div")].find(
        (d) => d.textContent?.includes("Save for Acme") && d.className.includes("rounded-md")
      )!;
    await click(acme().querySelector('button[role="switch"]'));
    await click(acme().querySelector('button[aria-label="Add Groq to the order"]'));
    await click(buttonByText("Save for Acme"));
    const put = calls.find((c) => c.url === "/api/tenants/t-acme/routing")!;
    expect(put.body).toEqual({ profileId: null, transparent: null, priority: ["groq"] });
  });
});

it("attaches an instance profile with inheritance without copying effective values into overrides", async () => {
  await mount();
  await act(async () => {
    const select = container.querySelectorAll("select")[0];
    select.value = "p";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.querySelectorAll("select")[1].value).toBe("inherit");
  await click(buttonByText("Save"));
  const saved = calls.find((call) => call.method === "PUT" && call.url === "/api/routing")!;
  expect(saved.body).toEqual({
    profileId: "p",
    transparent: null,
    providerPriority: null,
    delegateToTenants: false,
  });
  expect(buttonByText("Save")!.disabled).toBe(true);
});
