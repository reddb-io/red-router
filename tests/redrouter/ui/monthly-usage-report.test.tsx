// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
import MonthlyUsageReport from "@/shared/components/MonthlyUsageReport";
import type { MonthlyCostReport } from "@/lib/db/monthlyCostReport";

let root: Root;
let container: HTMLElement;
let requests: string[];
let respond: (url: string) => Promise<Response>;
const report = (month = "2026-09"): MonthlyCostReport => ({
  month,
  timezone: "UTC",
  since: `${month}-01T00:00:00.000Z`,
  until: "2026-10-01T00:00:00.000Z",
  sources: { requests: "usage_history", cost: "request_cost_ledger" },
  coverage: "Entry counts are not pricing coverage. Recorded amounts are not invoices.",
  total: {
    requests: 3,
    errors: 1,
    inputTokens: 30,
    outputTokens: 6,
    recordedCostUsd: 0,
    ledgerEntries: 1,
  },
  keys: [
    {
      tenantId: "a",
      tenantName: "Acme",
      apiKeyId: "unknown",
      name: "Unknown price",
      current: true,
      lastUsed: null,
      requests: 2,
      errors: 1,
      inputTokens: 20,
      outputTokens: 4,
      recordedCostUsd: null,
      ledgerEntries: 0,
    },
    {
      tenantId: "a",
      tenantName: "Acme",
      apiKeyId: "zero",
      name: "Recorded zero",
      current: false,
      lastUsed: null,
      requests: 1,
      errors: 0,
      inputTokens: 10,
      outputTokens: 2,
      recordedCostUsd: 0,
      ledgerEntries: 1,
    },
  ],
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  requests = [];
  respond = async () => Response.json({ report: report() });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return respond(String(input));
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const mount = async (props: React.ComponentProps<typeof MonthlyUsageReport> = {}) => {
  await act(async () => root.render(<MonthlyUsageReport initialMonth="2026-09" {...props} />));
};
const changeMonth = async (month: string) => {
  await act(async () => {
    const input = container.querySelector('input[type="month"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, month);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

it("distinguishes unknown from recorded zero and gives the original assignment and UTC bounds", async () => {
  await mount({ apiKeyIds: ["zero", "unknown"] });
  const rows = container.querySelectorAll("tbody tr");
  expect(rows[0].textContent).toContain("Not recorded");
  expect(rows[0].textContent).not.toContain("$0.0000");
  expect(rows[1].textContent).toContain("$0.0000");
  expect(rows[1].textContent).toContain("Historical tenant assignment");
  expect(container.textContent).toContain("2026-09-01T00:00:00.000Z");
  expect(container.textContent).toContain("not pricing coverage");
  expect(new URL(requests[0], "http://localhost").searchParams.getAll("apiKeyId")).toEqual([
    "unknown",
    "zero",
  ]);
});

it("an unsuccessful read shows an error with retry, never a fabricated zero report", async () => {
  respond = async () => new Response("private upstream error", { status: 500 });
  await mount({ tenantId: "acme" });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unable to load");
  expect(container.querySelector("table")).toBeNull();
  expect(container.textContent).not.toContain("private upstream error");
  respond = async () => Response.json({ report: report() });
  await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
  expect(container.querySelector("table")).not.toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(
    requests.every(
      (url) => new URL(url, "http://localhost").searchParams.get("tenantId") === "acme"
    )
  ).toBe(true);
  expect(container.querySelector("thead")?.textContent).not.toContain("Tenant");
});

it("refuses a successful HTTP response for a different month", async () => {
  respond = async () => Response.json({ report: report("2026-08") });
  await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unable to load");
  expect(container.querySelector("table")).toBeNull();
});

it("month and scope changes hide old results; late responses cannot relabel another month or tenant", async () => {
  let finishOld!: (response: Response) => void;
  respond = async (url) =>
    url.includes("2026-09")
      ? new Promise((resolve) => {
          finishOld = resolve;
        })
      : Response.json({ report: report("2026-08") });
  await mount({ tenantId: "a" });
  await changeMonth("2026-08");
  expect(container.textContent).toContain("2026-08-01");
  await act(async () =>
    finishOld(
      Response.json({
        report: { ...report(), keys: [{ ...report().keys[0], name: "Stale private key" }] },
      })
    )
  );
  expect(container.textContent).not.toContain("Stale private key");
  expect(container.textContent).not.toContain("2026-09-01");
  await act(async () => root.render(<MonthlyUsageReport tenantId="b" initialMonth="2026-09" />));
  expect(new URL(requests.at(-1)!, "http://localhost").searchParams.get("tenantId")).toBe("b");
});
