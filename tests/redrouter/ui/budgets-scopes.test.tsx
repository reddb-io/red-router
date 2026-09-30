// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/i18n/messages/en.json";

// next-intl stub backed by the real English messages, so a missing key shows up as the key.
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
import AttributionRollup from "@/app/(dashboard)/dashboard/costs/budget/AttributionRollup";

const HOSTILE = '<img src=x onerror="alert(1)">';

const budget = (overrides: Record<string, unknown>) => ({
  id: "b1",
  name: "Scoped cap",
  maxUsd: 100,
  softUsd: null,
  effectiveSoftUsd: 80,
  duration: "monthly",
  resetTime: null,
  onExceed: "block",
  throttleDelayMs: 1000,
  tpmLimit: null,
  rpmLimit: null,
  modelMax: {},
  enabled: true,
  keyIds: [],
  groupIds: [],
  tags: [],
  users: [],
  usage: { spentUsd: 10, windowStart: null, resetAt: null },
  ...overrides,
});

let root: Root | null = null;
let container: HTMLElement;
let budgets: Record<string, unknown>[];
let calls: { url: string; method: string; body?: string }[];
let rollupRows: Record<string, { key: string; amountUsd: number; requestCount: number }[]>;

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  calls = [];
  budgets = [];
  rollupRows = { tag: [], user: [] };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (url === "/api/budgets" && !init?.method) return respond({ budgets });
      if (url === "/api/keys") return respond({ keys: [] });
      if (url === "/api/keys/groups") return respond({ groups: [] });
      if (url.startsWith("/api/usage/attribution")) {
        const by =
          new URL(url, "http://localhost").searchParams.get("by") === "user" ? "user" : "tag";
        return respond({ by, days: 30, rows: rollupRows[by] });
      }
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

async function render(element: React.ReactElement) {
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
  });
}

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const inputLabelled = (label: string) =>
  [...document.querySelectorAll("input")].find((candidate) =>
    candidate.labels?.[0]?.textContent?.startsWith(label)
  ) as HTMLInputElement;

const button = (text: string) =>
  [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === text);

describe("BudgetsTable scopes and limits", () => {
  it("shows the rate limit column, model cap count and tag / end-user chips", async () => {
    budgets = [
      budget({
        tpmLimit: 50000,
        rpmLimit: 120,
        modelMax: { "openai/gpt-4o": 2, "anthropic/*": 5 },
        tags: ["team-a", "ops", "finance", "extra"],
        users: ["alice"],
      }),
      budget({ id: "b2", name: "Plain" }),
    ];
    await render(<BudgetsTable />);
    expect(container.querySelector("thead")!.textContent).toContain("Rate limit");
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows[0].textContent).toContain("50,000 tokens/min");
    expect(rows[0].textContent).toContain("120 requests/min");
    expect(rows[0].textContent).toContain("Model caps: 2");
    expect(rows[0].textContent).toContain("tag: team-a");
    expect(rows[0].textContent).toContain("tag: ops");
    expect(rows[0].textContent).toContain("tag: finance");
    expect(rows[0].textContent).not.toContain("tag: extra");
    expect(rows[0].textContent).toContain("+2");
    // A budget assigned only to tags is not "Nobody yet"; one with nothing is.
    expect(rows[0].textContent).not.toContain("Nobody yet");
    expect(rows[1].textContent).toContain("None");
    expect(rows[1].textContent).toContain("Nobody yet");
  });

  it("renders client-supplied tags and end users as escaped text", async () => {
    budgets = [budget({ tags: [HOSTILE], users: [HOSTILE] })];
    await render(<BudgetsTable />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("tbody")!.textContent).toContain(HOSTILE);
  });

  it("creates a budget with rate limits, model caps, tags and end users", async () => {
    await render(<BudgetsTable />);
    await act(async () => button("New budget")!.click());
    await typeInto(inputLabelled("Name"), "Scoped");
    await typeInto(inputLabelled("Limit (USD)"), "50");
    await typeInto(inputLabelled("Tokens per minute"), "10000");
    await typeInto(inputLabelled("Requests per minute"), "30");

    await act(async () => button("Add model cap")!.click());
    await typeInto(
      document.querySelector('input[aria-label="Model"]') as HTMLInputElement,
      "openai/gpt-4o"
    );
    await typeInto(
      document.querySelector('input[aria-label="Cap (USD)"]') as HTMLInputElement,
      "5"
    );

    const addButtons = () =>
      [...document.querySelectorAll("button")].filter((b) => b.textContent === "Add");
    await typeInto(inputLabelled("Tags"), "Team-A, ops");
    await act(async () => addButtons()[0].click());
    await typeInto(inputLabelled("End users"), "alice@example.com");
    await act(async () => addButtons()[1].click());
    expect(document.body.textContent).toContain("team-a");

    await act(async () => button("Create budget")!.click());
    const post = calls.find((call) => call.method === "POST");
    expect(JSON.parse(post!.body!)).toMatchObject({
      name: "Scoped",
      maxUsd: 50,
      tpmLimit: 10000,
      rpmLimit: 30,
      modelMax: { "openai/gpt-4o": 5 },
      tags: ["team-a", "ops"],
      users: ["alice@example.com"],
    });
  });

  it("refuses bad rate limits and model caps before calling the API", async () => {
    await render(<BudgetsTable />);
    await act(async () => button("New budget")!.click());
    await typeInto(inputLabelled("Name"), "Bad");
    await typeInto(inputLabelled("Limit (USD)"), "10");

    await typeInto(inputLabelled("Tokens per minute"), "1.5");
    await act(async () => button("Create budget")!.click());
    expect(document.body.textContent).toContain("whole numbers greater than 0");
    await typeInto(inputLabelled("Tokens per minute"), "");

    await act(async () => button("Add model cap")!.click());
    await typeInto(
      document.querySelector('input[aria-label="Model"]') as HTMLInputElement,
      "bad key!"
    );
    await typeInto(
      document.querySelector('input[aria-label="Cap (USD)"]') as HTMLInputElement,
      "5"
    );
    await act(async () => button("Create budget")!.click());
    expect(document.body.textContent).toContain("provider/model, a model id or provider/*");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("edits a budget and sends the full assignment set including tags and end users", async () => {
    budgets = [budget({ tags: ["team-a"], users: ["alice"], tpmLimit: 100 })];
    await render(<BudgetsTable />);
    await act(async () =>
      (container.querySelector('[aria-label="Edit Scoped cap"]') as HTMLElement).click()
    );
    expect(inputLabelled("Tokens per minute").value).toBe("100");
    await act(async () => button("Save")!.click());
    const put = calls.find((call) => call.method === "PUT");
    expect(put?.url).toBe("/api/budgets/b1/assignments");
    expect(JSON.parse(put!.body!)).toEqual({
      keyIds: [],
      groupIds: [],
      tags: ["team-a"],
      users: ["alice"],
    });
    const patch = calls.find((call) => call.method === "PATCH");
    expect(JSON.parse(patch!.body!)).toMatchObject({ tpmLimit: 100, rpmLimit: null, modelMax: {} });
  });
});

describe("AttributionRollup", () => {
  it("lists spend by tag, switches to end users and escapes what clients sent", async () => {
    rollupRows = {
      tag: [{ key: "team-a", amountUsd: 12.5, requestCount: 3400 }],
      user: [{ key: HOSTILE, amountUsd: 1.25, requestCount: 2 }],
    };
    await render(<AttributionRollup />);
    expect(document.body.textContent).toContain("Spend by tag / end user");
    expect(container.querySelector("tbody")!.textContent).toContain("team-a");
    expect(container.querySelector("tbody")!.textContent).toContain("$12.50");
    expect(container.querySelector("tbody")!.textContent).toContain("3,400");
    expect(calls.some((call) => call.url === "/api/usage/attribution?by=tag&days=30")).toBe(true);

    const select = [...container.querySelectorAll("select")].find((candidate) =>
      candidate.labels?.[0]?.textContent?.startsWith("Group by")
    ) as HTMLSelectElement;
    await act(async () => {
      select.value = "user";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(calls.some((call) => call.url === "/api/usage/attribution?by=user&days=30")).toBe(true);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("tbody")!.textContent).toContain(HOSTILE);
  });

  it("says so when nothing is attributed", async () => {
    await render(<AttributionRollup />);
    expect(document.body.textContent).toContain("No attributed spend in this period.");
  });
});
