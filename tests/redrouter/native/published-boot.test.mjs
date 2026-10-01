import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { checkPublishedHealth } from "../../../scripts/ci/check-published-boot.mjs";

test("public package smoke requires real readiness, a session and the exact authenticated version", async () => {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/healthz")) return new Response("ok");
    if (url.endsWith("/api/auth/login"))
      return Response.json({}, { headers: { "Set-Cookie": "session=fixture; HttpOnly; Path=/" } });
    return Response.json({ version: "0.56.3" });
  };
  assert.equal(
    await checkPublishedHealth("http://localhost:25050", "0.56.3", "fixture-password", request),
    true
  );
  assert.equal(calls.at(-1).init.headers.cookie, "session=fixture");
  await assert.rejects(
    checkPublishedHealth("http://localhost:25050", "0.56.4", "fixture-password", request),
    /version mismatch/
  );
  await assert.rejects(
    checkPublishedHealth("http://localhost:25050", "0.56.3", "fixture-password", async (url) =>
      url.endsWith("/healthz") ? new Response("ok") : Response.json({}, { status: 401 })
    ),
    /login HTTP 401/
  );
  assert.equal(
    await checkPublishedHealth(
      "http://localhost:25050",
      "0.56.3",
      "fixture-password",
      async () => new Response("starting", { status: 503 })
    ),
    false
  );
});
test("publication boots the npm-installed CLI without rebuilding the deliverable", async () => {
  const source = await readFile(
    new URL("../../../.github/workflows/red-publish.yml", import.meta.url),
    "utf8"
  );
  assert.ok(
    source.includes('mise exec -- node "$GITHUB_WORKSPACE/scripts/ci/check-published-boot.mjs"')
  );
  const start = source.indexOf("      - name: Smoke the published package");
  const end = source.indexOf("      - name: Create GitHub Release", start);
  const smoke = source.slice(start, end);
  assert.ok(smoke.includes("mise install --verbose"));
  assert.doesNotMatch(smoke, /build:release|npm pack|npm pkg set/);
});
