import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  handleCatalogDiscovery,
  handleKeyDiscovery,
  type DiscoveryDependencies,
} from "../../open-sse/handlers/clientDiscovery.ts";
import { classifyRoute } from "../../src/server/authz/classify.ts";
import { handleCorsOptions } from "../../src/shared/utils/cors.ts";

function dependencies(overrides: Partial<DiscoveryDependencies> = {}): DiscoveryDependencies {
  return {
    authenticate: async (token) =>
      token === "valid"
        ? {
            id: "key-1",
            name: "Personal",
            role: "standard",
            idFormat: "flat",
            persisted: true,
          }
        : null,
    catalog: async () => Response.json({ data: [] }),
    version: "test-version",
    mcpSchemaVersion: 4,
    strategies: ["priority", "auto"],
    decision: {
      header: "x-red-router-decision",
      hintHeader: "x-red-router-hint",
      hintKeys: ["tier"],
    },
    ...overrides,
  };
}

function request(path: string, token: string | null = "valid") {
  return new Request(`http://localhost:25050/v1/${path}`, {
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
}

describe("RedRouter key discovery", () => {
  it("projects only the public persisted-key identity and legacy MCP contract", async () => {
    const response = await handleKeyDiscovery(
      request("key"),
      dependencies({
        authenticate: async () => ({
          id: "key-1",
          name: "Personal",
          role: "standard",
          idFormat: "flat",
          persisted: true,
          keyHash: "private-hash",
          machineId: "private-machine",
          key: "private-secret",
        }),
      })
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      object: "api_key",
      id: "key-1",
      name: "Personal",
      role: "standard",
      id_format: "flat",
      mcp: {
        url: "http://localhost:25050/v1/mcp",
        transport: "streamable-http",
        schema_version: 4,
        admin_tools: false,
        local_only: true,
      },
    });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.match(response.headers.get("vary")!, /Authorization/);
  });

  it("advertises admin tools only for an authenticated management key", async () => {
    const response = await handleKeyDiscovery(
      request("key"),
      dependencies({
        authenticate: async () => ({
          id: "admin-key",
          name: "Admin",
          role: "admin",
          idFormat: "prefixed",
          persisted: true,
        }),
      })
    );
    const body = await response.json();
    assert.equal(body.role, "admin");
    assert.equal(body.mcp.admin_tools, true);
    assert.equal(body.id_format, "prefixed");
  });

  it("rejects absent, invalid and non-persisted keys even in anonymous mode", async () => {
    for (const token of [null, "invalid", "revoked", "expired", "inactive"]) {
      const response = await handleKeyDiscovery(request("key", token), dependencies());
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, "invalid_api_key");
      assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="red-router"');
    }
    const response = await handleKeyDiscovery(
      request("key"),
      dependencies({
        authenticate: async () => ({
          id: "env-key",
          name: "Environment",
          role: "admin",
          idFormat: "prefixed",
          persisted: false,
        }),
      })
    );
    assert.equal(response.status, 401);
  });

  it("accepts x-api-key but never credentials in query strings", async () => {
    const viaHeader = new Request("http://localhost:25050/v1/key", {
      headers: { "x-api-key": "valid" },
    });
    assert.equal((await handleKeyDiscovery(viaHeader, dependencies())).status, 200);
    assert.equal(
      (await handleKeyDiscovery(request("key?key=valid", null), dependencies())).status,
      401
    );
  });
});

describe("RedRouter catalog and capability discovery", () => {
  it("groups only the calling key's authorized models without changing routable IDs", async () => {
    const seen: string[] = [];
    const deps = dependencies({
      authenticate: async (token) => ({
        id: token,
        name: token,
        role: "standard",
        idFormat: "prefixed",
        persisted: true,
      }),
      catalog: async (req) => {
        assert.equal(new URL(req.url).pathname, "/api/v1/models");
        assert.equal(new URL(req.url).search, "");
        const token = req.headers.get("authorization")!.slice(7);
        seen.push(token);
        return Response.json({
          data: [
            {
              id: `remote/${token}/model`,
              owned_by: "red-router",
              name: "Remote",
              capabilities: { tools: true },
            },
            { id: `${token}/combo`, owned_by: "combo", members: [`remote/${token}/model`] },
            { id: `${token}/alias`, owned_by: "alias", alias_of: `remote/${token}/model` },
          ],
        });
      },
    });
    for (const token of ["tenant-a", "tenant-b"]) {
      const response = await handleCatalogDiscovery(
        request("catalog?for=redcode&variants=expand", token),
        deps,
        "catalog"
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.groups[0].provider, { id: "red-router" });
      assert.equal(body.groups[0].models[0].id, `remote/${token}/model`);
      assert.deepEqual(body.groups[0].models[0].capabilities, { tools: true });
      assert.equal(body.combos[0].id, `${token}/combo`);
      assert.equal(body.aliases[0].id, `${token}/alias`);
      assert.deepEqual(body.recommended, {});
      assert.equal(body.compatibility.complete, false);
      assert.ok(!("connections" in body.groups[0].provider));
      assert.ok(!JSON.stringify(body).includes(token === "tenant-a" ? "tenant-b" : "tenant-a"));
    }
    assert.deepEqual(seen, ["tenant-a", "tenant-b"]);
  });

  it("normalizes alternate key headers before invoking the scoped catalog", async () => {
    for (const name of ["x-api-key", "x-goog-api-key"]) {
      const req = new Request("http://localhost/v1/catalog", { headers: { [name]: "valid" } });
      const response = await handleCatalogDiscovery(
        req,
        dependencies({
          catalog: async (inner) => {
            assert.equal(inner.headers.get("Authorization"), "Bearer valid");
            return Response.json({ data: [] });
          },
        }),
        "catalog"
      );
      assert.equal(response.status, 200);
    }
  });

  it("never downgrades explicit invalid credentials to an anonymous catalog", async () => {
    for (const headers of [
      { Authorization: "Bearer invalid" },
      { Authorization: "Basic invalid", "x-api-key": "valid" },
      { "x-api-key": "invalid" },
      { "x-api-key": "" },
      { "x-goog-api-key": "invalid" },
    ]) {
      const req = new Request("http://localhost/v1/catalog", { headers });
      const response = await handleCatalogDiscovery(
        req,
        dependencies({
          catalog: async () => {
            assert.fail("must not load a catalog");
          },
        }),
        "catalog"
      );
      assert.equal(response.status, 401);
    }
  });

  it("delegates anonymous access policy and preserves catalog rejection diagnostics", async () => {
    for (const status of [401, 403, 429, 503]) {
      const response = await handleCatalogDiscovery(
        request("catalog", null),
        dependencies({
          catalog: async () =>
            Response.json(
              { error: { message: "Unavailable" } },
              {
                status,
                headers: { "retry-after": "30", Vary: "Origin", "Cache-Control": "public" },
              }
            ),
        }),
        "catalog"
      );
      assert.equal(response.status, status);
      assert.equal(response.headers.get("retry-after"), "30");
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.match(response.headers.get("vary")!, /Origin/);
    }
  });

  it("removes stale entity headers and keeps central CORS decisions", async () => {
    const response = await handleCatalogDiscovery(
      request("catalog"),
      dependencies({
        catalog: async () =>
          Response.json(
            { data: [] },
            {
              headers: {
                "content-length": "999",
                "content-encoding": "gzip",
                ETag: "old",
                "last-modified": "old",
                Vary: "Origin",
                "access-control-allow-origin": "https://client.example",
              },
            }
          ),
      }),
      "catalog"
    );
    for (const name of ["content-length", "content-encoding", "etag", "last-modified"]) {
      assert.equal(response.headers.get(name), null);
    }
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("access-control-allow-origin"), "https://client.example");
    assert.match(response.headers.get("vary")!, /x-api-key/);
  });

  it("rejects partial catalogs and unsupported variant semantics explicitly", async () => {
    for (const query of [
      "limit=1",
      "after=private-model",
      "type=llm",
      "variants=collapse",
      "key=valid",
    ]) {
      const response = await handleCatalogDiscovery(
        request(`capabilities?${query}`),
        dependencies({
          catalog: async () => {
            assert.fail("unsupported query must not reach catalog");
          },
        }),
        "capabilities"
      );
      assert.equal(response.status, 400);
    }
  });

  it("shares a content version across discovery documents, ignoring build timestamps", async () => {
    let created = 1;
    const deps = dependencies({
      catalog: async () =>
        Response.json({
          data: [
            {
              id: "typesafe-ai/jev-latest",
              owned_by: "typesafe-ai",
              type: "systemone",
              created: created++,
            },
          ],
        }),
    });
    const catalog = await (
      await handleCatalogDiscovery(request("catalog"), deps, "catalog")
    ).json();
    const capabilities = await (
      await handleCatalogDiscovery(request("capabilities"), deps, "capabilities")
    ).json();
    assert.equal(catalog.version, capabilities.catalog.version);
    assert.deepEqual(capabilities.systemone.models, ["typesafe-ai/jev-latest"]);
    assert.equal(capabilities.systemone.availability, "not_probed");
    assert.ok(!("available" in capabilities.systemone));
    assert.equal(capabilities.product, "red-router");
    assert.equal(capabilities.version, "test-version");
    assert.equal(capabilities.catalog.recommendations, false);
    assert.equal(capabilities.catalog.key_id_format_applied, false);
    assert.equal(capabilities.decision.scope, "combo");
    assert.ok(!("mode" in capabilities.decision));
    assert.deepEqual(capabilities.combos.strategies, ["priority", "auto"]);
    const other = await (
      await handleCatalogDiscovery(request("catalog"), dependencies(), "catalog")
    ).json();
    assert.notEqual(catalog.version, other.version);
  });

  it("fails closed for malformed catalogs and sanitizes internal exceptions", async () => {
    for (const catalog of [
      async () => Response.json({ data: [{ name: "Missing id" }] }),
      async () => Response.json({ data: "not-an-array" }),
      async () => new Response("not-json"),
      async (): Promise<Response> => {
        throw new Error("private-secret at /private/server.ts:42");
      },
    ]) {
      const response = await handleCatalogDiscovery(
        request("catalog"),
        dependencies({ catalog }),
        "catalog"
      );
      assert.equal(response.status, 500);
      const body = await response.text();
      assert.ok(!body.includes("at /"));
      assert.ok(!body.includes("private-secret"));
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
    const keyResponse = await handleKeyDiscovery(
      request("key"),
      dependencies({
        authenticate: async () => {
          throw new Error("private-secret at /private/database.ts:10");
        },
      })
    );
    assert.equal(keyResponse.status, 500);
    assert.ok(!(await keyResponse.text()).includes("private-secret"));
  });

  it("uses the existing client-API authorization class and no wildcard preflight", () => {
    for (const endpoint of ["key", "catalog", "capabilities"]) {
      for (const prefix of ["/v1/", "/api/v1/"]) {
        assert.equal(classifyRoute(`${prefix}${endpoint}`, "GET").routeClass, "CLIENT_API");
      }
    }
    const preflight = handleCorsOptions();
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);
  });
});
