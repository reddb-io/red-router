import { beforeEach, describe, expect, it, vi } from "vitest";

describe("API key search (pickers over many keys)", () => {
  let repo;
  beforeEach(async () => {
    vi.resetModules();
    const { getDb } = await import("@/lib/db/kysely.js");
    await (await getDb()).deleteFrom("apiKeys").execute();
    repo = await import("@/lib/db/repos/apiKeysRepo.js");
    for (let i = 0; i < 30; i++) await repo.createApiKey(`client-${String(i).padStart(2, "0")}`, "m", i % 10 === 0 ? ["billable"] : null, null);
    await repo.createApiKey("Acme Prod", "m", ["customer-a"], null);
    await repo.createApiKey("owned", "m", null, "alice@example.com");
  });

  it("returns one page with the total, never the secret", async () => {
    const page = await repo.searchApiKeys({ limit: 5 });
    expect(page.total).toBe(32);
    expect(page.keys).toHaveLength(5);
    expect(page.keys[0]).not.toHaveProperty("key");
    const next = await repo.searchApiKeys({ limit: 5, offset: 5 });
    expect(next.keys[0].name).not.toBe(page.keys[0].name);
  });

  it("matches name or tag, case-insensitively", async () => {
    expect((await repo.searchApiKeys({ q: "acme" })).keys.map((k) => k.name)).toEqual(["Acme Prod"]);
    expect((await repo.searchApiKeys({ q: "BILLABLE" })).total).toBe(3);
  });

  it("looks keys up by id, every id asked for", async () => {
    const all = (await repo.searchApiKeys({ limit: 100 })).keys;
    const ids = all.slice(0, 25).map((k) => k.id);
    const found = await repo.searchApiKeys({ ids });
    expect(found.keys.map((k) => k.id).sort()).toEqual([...ids].sort());
    expect(await repo.searchApiKeys({ ids: [] })).toEqual({ keys: [], total: 0 });
  });

  it("keeps a scoped owner to shared keys and their own", async () => {
    const bob = await repo.searchApiKeys({ q: "owned", owner: "bob@example.com" });
    expect(bob.total).toBe(0);
    const alice = await repo.searchApiKeys({ q: "owned", owner: "alice@example.com" });
    expect(alice.keys.map((k) => k.name)).toEqual(["owned"]);
  });
});
