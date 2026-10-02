import assert from "node:assert/strict";
import { test } from "node:test";
import {
  forwardSystemOne,
  resolveSystemOneTarget,
} from "../../../open-sse/handlers/systemOneCore.ts";
const target = resolveSystemOneTarget("openrouter/typesafe/jev-1.13")!;
const body = { state: "Ready", questions: { ready: { type: "noul" } } };

test("OpenRouter's documented native typed endpoint is /api/v1/systemone", () => {
  assert.equal(target.url, "https://openrouter.ai/api/v1/systemone");
  assert.equal(target.model, "typesafe/jev-1.13");
});
test("S1 exposes stable diagnostics and status without leaking upstream text", async () => {
  for (const [status, error, code] of [
    [401, { message: "secret refused at /private" }, "systemone_credential_rejected"],
    [403, {}, "systemone_credential_rejected"],
    [405, {}, "systemone_endpoint_not_found"],
    [404, { code: "route_not_found" }, "systemone_endpoint_not_found"],
    [404, { code: "model_not_found" }, "systemone_model_unavailable"],
    [400, { message: "Model does not exist: secret" }, "systemone_model_unavailable"],
    [404, {}, "systemone_resource_not_found"],
    [502, { message: "secret at /private" }, "systemone_upstream_http_error"],
  ] as const) {
    const result = await forwardSystemOne(target, "fixture", body, {
      fetchImpl: async () => Response.json({ error }, { status, headers: { "retry-after": "3" } }),
    });
    assert.equal(result.response.status, status);
    const payload = await result.response.json();
    assert.equal(payload.error.code, code);
    assert.equal(JSON.stringify(payload).includes("secret"), false);
    assert.equal(JSON.stringify(payload).includes("at /"), false);
    assert.equal(result.response.headers.get("retry-after"), "3");
  }
  const transport = await forwardSystemOne(target, "fixture", body, {
    fetchImpl: async () => {
      throw new Error("secret transport details");
    },
  });
  assert.equal(transport.response.status, 502);
  assert.equal((await transport.response.json()).error.code, "systemone_transport_failure");
});
test("a successful HTTP status is insufficient without complete typed answers", async () => {
  for (const payload of [
    { answers: {} },
    { answers: { ready: { noul: "yes" } } },
    { answers: { ready: { noul: 2 } } },
    { answers: { ready: { type: "choice", noul: 1 } } },
  ]) {
    const result = await forwardSystemOne(target, "fixture", body, {
      fetchImpl: async () => Response.json(payload),
    });
    assert.equal(result.response.status, 502);
    assert.equal((await result.response.json()).error.code, "systemone_invalid_response");
  }
  const valid = await forwardSystemOne(target, "fixture", body, {
    fetchImpl: async () => Response.json({ answers: { ready: { type: "noul", noul: 0.5 } } }),
  });
  assert.equal(valid.response.status, 200);
});
