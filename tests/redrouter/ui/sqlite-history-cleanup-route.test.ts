// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

const { auth, policy, cleanup } = vi.hoisted(() => ({
  auth: vi.fn(),
  policy: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock("@/lib/api/requireManagementAuth", () => ({ requireManagementAuth: auth }));
vi.mock("@/lib/db/historyRetentionPolicy", () => ({ getHistoryWindowDays: policy }));
vi.mock("@/lib/db/cleanup", () => ({ runScheduledCleanupPass: cleanup }));

import { POST } from "@/app/api/settings/database/cleanup/route";

const request = (body: unknown) =>
  new Request("http://localhost/api/settings/database/cleanup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  auth.mockResolvedValue(null);
  policy.mockReturnValue(7);
  cleanup.mockResolvedValue({ totalDeleted: 12, totalErrors: 0 });
});

it("requires management authentication before reading policy or deleting", async () => {
  auth.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
  expect((await POST(request({ days: 7 }))).status).toBe(401);
  expect(auth).toHaveBeenCalledWith(expect.any(Request), { alwaysRequireAuth: true });
  expect(policy).not.toHaveBeenCalled();
  expect(cleanup).not.toHaveBeenCalled();
});

it("rejects Off, invalid windows and unsaved selections without deletion", async () => {
  for (const days of [0, 1, -7, "7"]) {
    expect((await POST(request({ days }))).status).toBe(400);
  }
  policy.mockReturnValue(0);
  expect((await POST(request({ days: 7 }))).status).toBe(409);
  policy.mockReturnValue(14);
  expect((await POST(request({ days: 7 }))).status).toBe(409);
  expect(cleanup).not.toHaveBeenCalled();
});

it("reports rows deleted through the scheduled cleanup path", async () => {
  const response = await POST(request({ days: 7 }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true, days: 7, deleted: 12 });
  expect(cleanup).toHaveBeenCalledWith("periodic");
});

it("reports a changed policy rather than claiming completion under the old window", async () => {
  policy.mockReturnValueOnce(7).mockReturnValue(0);
  expect((await POST(request({ days: 7 }))).status).toBe(409);
});

it("does not report success or leak internal details when a table fails", async () => {
  cleanup.mockResolvedValue({ totalDeleted: 12, totalErrors: 1 });
  const response = await POST(request({ days: 7 }));
  expect(response.status).toBe(500);
  const body = await response.json();
  expect(body.error.message).toContain("diagnostic logs");
  expect(body.error.message).not.toContain("at /");
});
