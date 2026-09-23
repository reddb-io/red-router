// Dashboard fixes: request details render any content shape; account order is
// saved in one transaction, keeps hidden accounts in place, and shared accounts
// stay admin-managed.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const scope = vi.hoisted(() => ({ identity: { isAdmin: true, owner: null }, visible: null, scoped: false }));
vi.mock("@/lib/auth/resourceScope", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    getScopeFilter: async () => null,
    getRequestIdentity: async () => scope.identity,
    isScopeEnabled: () => scope.scoped,
    scopeVisible: (list) => (scope.visible ? list.filter((c) => scope.visible.includes(c.id)) : list),
  };
});

let db;
let PUT;
let safeText;

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  await db.initDb();
  ({ PUT } = await import("../../src/app/api/providers/reorder/route.js"));
  ({ safeText } = await import("../../src/shared/utils/safeText.js"));
});

beforeEach(() => {
  scope.identity = { isAdmin: true, owner: null };
  scope.visible = null;
  scope.scoped = false;
});

async function makeProvider(provider, names) {
  const ids = [];
  for (const name of names) {
    const conn = await db.createProviderConnection({ provider, authType: "apikey", name, apiKey: `k-${name}`, isActive: true, owner: null });
    ids.push(conn.id);
  }
  return ids;
}
const order = async (provider) => (await db.getProviderConnections({ provider })).map((c) => [c.name, c.priority]);
const put = (body) => PUT(new Request("http://x/api/providers/reorder", { method: "PUT", body: JSON.stringify(body) }));

describe("safeText", () => {
  it("renders strings as-is and anything else as JSON", () => {
    expect(safeText("hi")).toBe("hi");
    expect(safeText(null)).toBeNull();
    expect(safeText([{ type: "text", text: "a" }])).toBe(JSON.stringify([{ type: "text", text: "a" }], null, 2));
  });
});

describe("setConnectionOrder", () => {
  it("writes the given order as priorities 1..N, unlisted accounts after, in place", async () => {
    const [a, b, c] = await makeProvider("order-test", ["a", "b", "c"]);
    await db.setConnectionOrder("order-test", [c, a]);
    expect(await order("order-test")).toEqual([["c", 1], ["a", 2], ["b", 3]]);
    await db.setConnectionOrder("order-test", [b, c, a, "unknown-id"]);
    expect(await order("order-test")).toEqual([["b", 1], ["c", 2], ["a", 3]]);
  });
});

describe("PUT /api/providers/reorder", () => {
  it("reorders the visible accounts inside their own slots, leaving hidden ones where they were", async () => {
    const [a, b, c, d] = await makeProvider("slots-test", ["a", "b", "c", "d"]);
    scope.visible = [a, c, d]; // b is someone else's and stays at position 2
    const res = await put({ provider: "slots-test", orderedIds: [d, a, c] });
    expect(res.status).toBe(200);
    expect(await order("slots-test")).toEqual([["d", 1], ["b", 2], ["a", 3], ["c", 4]]);
  });

  it("rejects an order that does not list every visible account exactly once", async () => {
    const [a, b] = await makeProvider("bad-test", ["a", "b"]);
    expect((await put({ provider: "bad-test", orderedIds: [a] })).status).toBe(400);
    expect((await put({ provider: "bad-test", orderedIds: [a, a] })).status).toBe(400);
    expect((await put({ provider: "bad-test", orderedIds: [a, b, "x"] })).status).toBe(400);
  });

  it("keeps shared accounts admin-managed when resources are scoped", async () => {
    const [a, b] = await makeProvider("shared-test", ["a", "b"]);
    scope.scoped = true;
    scope.identity = { isAdmin: false, owner: "alice" };
    expect((await put({ provider: "shared-test", orderedIds: [b, a] })).status).toBe(403);
  });
});
