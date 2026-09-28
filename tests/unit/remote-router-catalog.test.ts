import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redRouterEndpoint } from "../../open-sse/config/redRouter.ts";
import {
  createRemoteRouterCatalogSync,
  parseRemoteRouterModels,
  remoteRouterSnapshot,
  RemoteRouterDiscoveryError,
  type RemoteRouterCache,
} from "../../src/lib/providerModels/remoteRouterCatalog.ts";
import {
  applyRemoteRouterDiscoveryDefaults,
  shouldAutoSyncModels,
} from "../../src/lib/providerModels/discoveryPolicy.ts";

const connection = {
  id: "connection-a",
  provider: "red-router",
  apiKey: "remote-key-a",
  providerSpecificData: { baseUrl: "https://router.example" },
};

function fixture() {
  const cache = new Map<string, RemoteRouterCache>();
  let time = 1000;
  let calls = 0;
  let current = connection;
  let fetchImpl = async (_url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${current.apiKey}`);
    assert.equal(new Headers(init.headers).get("x-rr-internal-models-fetch"), "1");
    assert.equal(init.redirect, "error");
    return Response.json({ data: [{ id: "cc/claude-example", name: "Remote model" }] });
  };
  const sync = createRemoteRouterCatalogSync({
    now: () => time,
    read: (snapshot) => cache.get(snapshot.id) ?? null,
    commit: (snapshot, value) => {
      if (remoteRouterSnapshot(current).fingerprint !== snapshot.fingerprint) return false;
      cache.set(snapshot.id, value);
      return true;
    },
    fetch: async (url, init, connectionId) => {
      assert.equal(connectionId, connection.id);
      calls++;
      return fetchImpl(url, init);
    },
  });
  return {
    sync,
    cache,
    calls: () => calls,
    advance: (ms: number) => {
      time += ms;
    },
    setCurrent: (value: typeof connection) => {
      current = value;
      cache.delete(value.id);
    },
    setFetch: (value: typeof fetchImpl) => {
      fetchImpl = value;
    },
  };
}

describe("RedRouter remote discovery", () => {
  it("normalizes the baseline URL forms consistently for discovery and chat", () => {
    for (const base of [
      "https://host",
      "https://host/v1/",
      "https://host/v1/models",
      "https://host/v1/chat/completions",
    ]) {
      assert.equal(redRouterEndpoint(base, "models"), "https://host/v1/models");
      assert.equal(redRouterEndpoint(base, "chat/completions"), "https://host/v1/chat/completions");
    }
    assert.equal(
      redRouterEndpoint("https://host/prefix/api/v1", "models"),
      "https://host/prefix/api/v1/models"
    );
    for (const base of [
      "file:///tmp/catalog",
      "https://user:secret@host",
      "https://host?key=secret",
      "https://host#part",
    ]) {
      assert.throws(() => redRouterEndpoint(base, "models"));
    }
  });

  it("persists on discovery, retains remote-qualified IDs, and refreshes after five minutes", async () => {
    const f = fixture();
    const first = await f.sync(connection);
    assert.equal(first.source, "api");
    assert.equal(first.models[0].id, "cc/claude-example");
    assert.equal(f.cache.size, 1);
    assert.equal((await f.sync(connection)).source, "cache");
    assert.equal(f.calls(), 1);
    f.advance(5 * 60 * 1000);
    assert.equal((await f.sync(connection)).source, "api");
    assert.equal(f.calls(), 2);
  });

  it("coalesces concurrent refreshes without a provider-global cache", async () => {
    const f = fixture();
    await Promise.all([f.sync(connection), f.sync(connection), f.sync(connection)]);
    assert.equal(f.calls(), 1);
    const changed = { ...connection, apiKey: "remote-key-b" };
    f.setCurrent(changed);
    f.setFetch(async () => {
      throw new Error("offline");
    });
    await assert.rejects(f.sync(changed), /catalog unavailable/);
    assert.equal(f.cache.size, 0);
    assert.notEqual(
      remoteRouterSnapshot(connection).fingerprint,
      remoteRouterSnapshot(changed).fingerprint
    );
    assert.notEqual(
      remoteRouterSnapshot(connection).fingerprint,
      remoteRouterSnapshot({
        ...connection,
        providerSpecificData: { baseUrl: "https://different.example" },
      }).fingerprint
    );
  });

  it("uses saved data for outages, but never calls fallback a successful sync", async () => {
    const f = fixture();
    await f.sync(connection);
    f.setFetch(async () => {
      throw new Error("secret at /private/network.ts:4");
    });
    const result = await f.sync(connection, true);
    assert.equal(result.source, "cache");
    assert.equal(result.models[0].id, "cc/claude-example");
    assert.ok(result.warning);
    assert.ok(!JSON.stringify(result).includes("secret"));
    assert.ok(!JSON.stringify(result).includes("at /"));
  });

  it("does not reuse cached data when the remote rejects its credential", async () => {
    const f = fixture();
    await f.sync(connection);
    for (const status of [401, 403]) {
      f.setFetch(async () => Response.json({ error: "private upstream detail" }, { status }));
      await assert.rejects(
        f.sync(connection, true),
        (error: unknown) =>
          error instanceof RemoteRouterDiscoveryError &&
          error.status === 502 &&
          !error.message.includes("private")
      );
    }
  });

  it("does not publish a fetch completed after the credential was edited", async () => {
    const f = fixture();
    f.setFetch(async () => {
      f.setCurrent({ ...connection, apiKey: "changed" });
      return Response.json({ data: [{ id: "private/old-key-model" }] });
    });
    await assert.rejects(
      f.sync(connection),
      (error: unknown) => error instanceof RemoteRouterDiscoveryError && error.status === 409
    );
    assert.equal(f.cache.size, 0);
  });

  it("a genuine empty catalog clears models while malformed or paged data does not", async () => {
    const f = fixture();
    await f.sync(connection);
    for (const body of [
      { data: [{ name: "no-id" }] },
      { error: "not a catalog" },
      { data: [], has_more: true },
    ]) {
      f.setFetch(async () => Response.json(body));
      const result = await f.sync(connection, true);
      assert.equal(result.source, "cache");
      assert.equal(result.models.length, 1);
    }
    f.setFetch(async () => Response.json({ data: [] }));
    assert.deepEqual((await f.sync(connection, true)).models, []);
    assert.deepEqual(f.cache.get(connection.id)?.models, []);
  });

  it("filters typed modalities and recursive routes without modifying opaque IDs", () => {
    const models = parseRemoteRouterModels({
      data: [
        { id: "vendor/space/model", capabilities: { tools: true }, secret: "must-drop" },
        { id: "typesafe-ai/jev-latest", type: "systemone" },
        { id: "image-model", type: "image" },
        { id: "red-router/vendor/model" },
        { id: "custom-prefix/model", provider: { via: "red-router" } },
        { id: "other", route: [{ instance: "upstream" }] },
      ],
    });
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "vendor/space/model");
    assert.equal(models[0].capabilities?.tools, true);
    assert.ok(!("secret" in models[0]));
  });

  it("restores automatic discovery only for RedRouter and honors an explicit opt-out", async () => {
    assert.deepEqual(applyRemoteRouterDiscoveryDefaults("red-router", {}), {
      autoFetchModels: true,
      autoSync: true,
    });
    assert.deepEqual(applyRemoteRouterDiscoveryDefaults("openai", {}), {});
    assert.equal(shouldAutoSyncModels("red-router", {}), true);
    assert.equal(shouldAutoSyncModels("red-router", { autoFetchModels: false }), false);
    assert.equal(shouldAutoSyncModels("red-router", { autoSync: false }), false);
    assert.equal(shouldAutoSyncModels("openai", {}), false);
    const f = fixture();
    const off = {
      ...connection,
      providerSpecificData: { ...connection.providerSpecificData, autoFetchModels: false },
    };
    assert.deepEqual((await f.sync(off)).models, []);
    assert.equal(f.calls(), 0);
    await f.sync(off, true);
    assert.equal(f.calls(), 1);
  });

  it("does not silently bypass unported legacy proxy settings", async () => {
    const f = fixture();
    await assert.rejects(
      f.sync({
        ...connection,
        providerSpecificData: { ...connection.providerSpecificData, connectionProxyEnabled: true },
      }),
      (error: unknown) => error instanceof RemoteRouterDiscoveryError && error.status === 400
    );
    assert.equal(f.calls(), 0);
  });
});
