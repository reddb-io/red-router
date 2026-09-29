// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/i18n/messages/en.json";

// next-intl stub backed by the real English messages, so a missing key shows up as the key.
// Like the real hook it returns a stable function per namespace (components list `t` in deps).
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

import BudgetsTable from "@/app/(dashboard)/dashboard/costs/budget/BudgetsTable";
import { meterTone } from "@/app/(dashboard)/dashboard/costs/budget/budgetsTypes";

const usage = (spentUsd: number) => ({ spentUsd, windowStart: null, resetAt: null });
const budget = (overrides: Record<string, unknown>) => ({
  id: "b1",
  name: "Team cap",
  maxUsd: 100,
  softUsd: null,
  effectiveSoftUsd: 80,
  duration: "monthly",
  resetTime: null,
  onExceed: "block",
  throttleDelayMs: 1000,
  enabled: true,
  keyIds: ["k1"],
  groupIds: ["g1"],
  usage: usage(10),
  ...overrides,
});

let root: Root | null = null;
let container: HTMLElement;
let budgets: Record<string, unknown>[];
let calls: { url: string; method: string; body?: string }[];

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  calls = [];
  budgets = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (url === "/api/budgets" && !init?.method) return respond({ budgets });
      if (url === "/api/keys") return respond({ keys: [{ id: "k1", name: "alice-key" }] });
      if (url === "/api/keys/groups") return respond({ groups: [{ id: "g1", name: "platform" }] });
      return respond({ budget: budgets[0] });
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
    root!.render(<BudgetsTable />);
  });
}

describe("BudgetsTable", () => {
  it("shows the empty state and opens the new-budget form from the primary button", async () => {
    await render();
    expect(document.body.textContent).toContain("No budgets yet");
    const primary = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "New budget"
    );
    expect(primary).toBeTruthy();
    await act(async () => primary!.click());
    expect(document.body.textContent).toContain("Limit (USD)");
    expect(document.body.textContent).toContain("alice-key");
    expect(document.body.textContent).toContain("platform");
  });

  it("renders one row per budget with limit, window, behaviour, assignees and use", async () => {
    budgets = [
      budget({ usage: usage(85) }),
      budget({
        id: "b2",
        name: "Slow lane",
        onExceed: "throttle",
        throttleDelayMs: 2500,
        duration: "daily",
        resetTime: "06:00",
        keyIds: [],
        groupIds: [],
        enabled: false,
        usage: usage(100),
      }),
    ];
    await render();
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Team cap");
    expect(rows[0].textContent).toContain("$100.00");
    expect(rows[0].textContent).toContain("soft $80.00");
    expect(rows[0].textContent).toContain("Monthly");
    expect(rows[0].textContent).toContain("Block");
    expect(rows[0].textContent).toContain("platform, alice-key");
    expect(rows[0].textContent).toContain("$85.00 of $100.00");
    expect(rows[1].textContent).toContain("Throttle 2.5s");
    expect(rows[1].textContent).toContain("resets 06:00 UTC");
    expect(rows[1].textContent).toContain("Nobody yet");
  });

  it("colours the meter only past 80% (warning) and 100% (danger)", async () => {
    budgets = [
      budget({ id: "a", usage: usage(50) }),
      budget({ id: "b", usage: usage(85) }),
      budget({ id: "c", usage: usage(120) }),
    ];
    await render();
    const fills = [...container.querySelectorAll('[role="meter"] > div')].map(
      (element) => element.className
    );
    expect(fills[0]).toContain("bg-ink-muted");
    expect(fills[1]).toContain("bg-feedback-warning-foreground");
    expect(fills[2]).toContain("bg-feedback-danger-foreground");
    expect(meterTone(79.9, 100)).toBe("neutral");
    expect(meterTone(80, 100)).toBe("warning");
    expect(meterTone(100, 100)).toBe("danger");
    // The fill never overflows its track.
    expect((container.querySelectorAll('[role="meter"] > div')[2] as HTMLElement).style.width).toBe(
      "100%"
    );
  });

  it("toggles a budget through PATCH and confirms before deleting", async () => {
    budgets = [budget({})];
    await render();
    const toggle = container.querySelector('[aria-label="Enable Team cap"]') as HTMLElement;
    expect(toggle).toBeTruthy();
    await act(async () => toggle.click());
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.url).toBe("/api/budgets/b1");
    expect(JSON.parse(patch!.body!)).toEqual({ enabled: false });

    const remove = container.querySelector('[aria-label="Delete Team cap"]') as HTMLElement;
    await act(async () => remove.click());
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(document.body.textContent).toContain("Delete budget");
  });

  it("creates a budget with the chosen limit, window and assignments", async () => {
    await render();
    const open = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "New budget"
    );
    await act(async () => open!.click());

    const type = async (label: string, value: string) => {
      const input = [...document.querySelectorAll("input")].find((candidate) =>
        candidate.labels?.[0]?.textContent?.startsWith(label)
      ) as HTMLInputElement;
      expect(input, label).toBeTruthy();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await type("Name", "Ops cap");
    await type("Limit (USD)", "250");
    await type("Soft threshold", "200");

    const groupBox = [...document.querySelectorAll('input[type="checkbox"]')].find((box) =>
      (box as HTMLInputElement).labels?.[0]?.textContent?.includes("platform")
    ) as HTMLInputElement;
    await act(async () => groupBox.click());

    const create = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Create budget"
    );
    await act(async () => create!.click());

    const post = calls.find((call) => call.method === "POST");
    expect(post?.url).toBe("/api/budgets");
    expect(JSON.parse(post!.body!)).toMatchObject({
      name: "Ops cap",
      maxUsd: 250,
      softUsd: 200,
      duration: "monthly",
      onExceed: "block",
      enabled: true,
      keyIds: [],
      groupIds: ["g1"],
    });
  });

  it("refuses a soft threshold above the limit before calling the API", async () => {
    await render();
    const open = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "New budget"
    );
    await act(async () => open!.click());
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const fill = async (label: string, value: string) => {
      const input = [...document.querySelectorAll("input")].find((candidate) =>
        candidate.labels?.[0]?.textContent?.startsWith(label)
      ) as HTMLInputElement;
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await fill("Name", "Bad");
    await fill("Limit (USD)", "10");
    await fill("Soft threshold", "20");
    const create = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Create budget"
    );
    await act(async () => create!.click());
    expect(document.body.textContent).toContain("not above the limit");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});
