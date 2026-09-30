import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "redrouter-otlp-templates-"));
process.env.DATA_DIR = dataDir;
process.env.STORAGE_ENCRYPTION_KEY = "otlp-templates-test-key";
delete process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;

const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const templates = await import("../../../src/lib/logExport/otlpTemplates.ts");
const otlp = await import("../../../src/lib/logExport/destinations/otlp.ts");
const registry = await import("../../../src/lib/logExport/registry.ts");
const route = await import("../../../src/app/api/log-export/otlp-templates/route.ts");

import type { LogExportRecord } from "../../../src/lib/logExport/types.ts";

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

const ENDPOINT = "https://collector.example.com:4318";
const minimalRecord = { id: "req-1", status: 200 } as unknown as LogExportRecord;

// --- template shape ---------------------------------------------------------------------------

test("every vendor the dashboard should offer has a template, with unique ids", () => {
  const ids = templates.OTLP_TEMPLATES.map((t) => t.id);
  assert.deepEqual(ids, [
    "langfuse",
    "helicone",
    "braintrust",
    "grafana-cloud",
    "honeycomb",
    "local-collector",
  ]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(templates.OTLP_TEMPLATES.map((t) => t.label)).size, ids.length);
});

test("templates are well formed and carry no credential", () => {
  for (const t of templates.OTLP_TEMPLATES) {
    assert.match(t.endpoint, /^https?:\/\//, t.id);
    assert.equal(typeof t.endpointIsFull, "boolean", t.id);
    assert.equal(typeof t.verified, "boolean", t.id);
    assert.match(t.docsUrl, /^https:\/\//, t.id);
    assert.ok(t.notes.length > 20, t.id);

    // Every header line parses with the destination's own parser (no reserved headers).
    const parsed = otlp.parseOtlpHeaders(t.headers);
    assert.equal(parsed.error, undefined, `${t.id}: ${parsed.error}`);

    // Every <token> is declared, and every declared placeholder is used.
    const used = new Set(
      [...`${t.endpoint}\n${t.headers}`.matchAll(/<([a-z][a-z0-9-]*)>/g)].map((m) => m[1])
    );
    assert.deepEqual([...used].sort(), [...t.placeholders].sort(), t.id);
  }
});

test("Helicone is flagged unverified, and so are the trace-oriented vendors", () => {
  const verified = Object.fromEntries(templates.OTLP_TEMPLATES.map((t) => [t.id, t.verified]));
  assert.equal(verified.helicone, false);
  assert.equal(verified.langfuse, false);
  assert.equal(verified.braintrust, false);
  assert.equal(verified["grafana-cloud"], true);
  assert.equal(verified.honeycomb, true);
  assert.equal(verified["local-collector"], true);
});

test("templates match the documented vendor endpoints and headers", () => {
  const get = (id: string) => templates.getOtlpTemplate(id)!;
  assert.equal(get("langfuse").endpoint, "https://cloud.langfuse.com/api/public/otel");
  assert.match(get("langfuse").headers, /^Authorization: Basic <basic-auth>$/m);
  assert.match(get("langfuse").headers, /^x-langfuse-ingestion-version: 4$/m);
  assert.equal(get("braintrust").endpoint, "https://api.braintrust.dev/otel");
  assert.match(get("braintrust").headers, /^Authorization: Bearer <api-key>$/m);
  assert.match(get("braintrust").headers, /^x-bt-parent: project_id:<project-id>$/m);
  assert.equal(get("honeycomb").endpoint, "https://api.honeycomb.io");
  assert.equal(get("honeycomb").headers, "x-honeycomb-team: <api-key>");
  assert.equal(get("local-collector").endpoint, "http://localhost:4318");
  assert.equal(get("local-collector").headers, "");
  assert.equal(templates.getOtlpTemplate("nope"), undefined);
});

// --- header builders ---------------------------------------------------------------------------

test("the Langfuse builder produces Basic base64(publicKey:secretKey) and the ingestion header", () => {
  const headers = templates.langfuseHeaders("pk-lf-1", "sk-lf-2");
  const expected = Buffer.from("pk-lf-1:sk-lf-2").toString("base64");
  assert.equal(expected, "cGstbGYtMTpzay1sZi0y");
  assert.deepEqual(headers.split("\n"), [
    `Authorization: Basic ${expected}`,
    "x-langfuse-ingestion-version: 4",
  ]);
  // The result is exactly what the destination's headers field accepts.
  assert.deepEqual(otlp.parseOtlpHeaders(headers).headers, {
    Authorization: `Basic ${expected}`,
    "x-langfuse-ingestion-version": "4",
  });
});

test("templates render with the operator's values and leave unknown tokens alone", () => {
  const grafana = templates.getOtlpTemplate("grafana-cloud")!;
  const rendered = templates.renderOtlpTemplate(grafana, {
    zone: "prod-eu-west-0",
    "basic-auth": templates.basicAuthValue("123456", "glc_token"),
  });
  assert.equal(rendered.endpoint, "https://otlp-gateway-prod-eu-west-0.grafana.net/otlp");
  assert.equal(
    rendered.headers,
    `Authorization: Basic ${Buffer.from("123456:glc_token").toString("base64")}`
  );
  assert.equal(rendered.endpointIsFull, false);
  assert.equal(templates.fillOtlpTemplate("Bearer <api-key>", {}), "Bearer <api-key>");
  // Values are data, never re-scanned for tokens.
  assert.equal(templates.fillOtlpTemplate("<a-b>", { "a-b": "<c>" }), "<c>");
});

test("a rendered template is accepted by the destination schema", () => {
  const honeycomb = templates.renderOtlpTemplate(templates.getOtlpTemplate("honeycomb")!, {
    "api-key": "hcaik_test",
  });
  const parsed = otlp.otlpConfigSchema.safeParse(honeycomb);
  assert.equal(parsed.success, true, JSON.stringify(parsed));
});

// --- endpointIsFull ----------------------------------------------------------------------------

function collector() {
  const urls: string[] = [];
  const httpFetch = async (url: string) => {
    urls.push(url);
    return new Response("{}", { status: 200 });
  };
  return { urls, httpFetch };
}
const base = { endpoint: ENDPOINT, headers: "", serviceName: "rr" };

test("by default /v1/logs is still appended exactly once, whatever the flag's absence or value", async () => {
  for (const flag of [undefined, false]) {
    for (const [endpoint, expected] of [
      [ENDPOINT, `${ENDPOINT}/v1/logs`],
      [`${ENDPOINT}/`, `${ENDPOINT}/v1/logs`],
      [`${ENDPOINT}/v1/logs`, `${ENDPOINT}/v1/logs`],
      [`${ENDPOINT}/otlp`, `${ENDPOINT}/otlp/v1/logs`],
    ]) {
      const { urls, httpFetch } = collector();
      await otlp
        .createOtlpClientForTest({ ...base, endpoint, endpointIsFull: flag }, httpFetch)
        .send([minimalRecord]);
      assert.deepEqual(urls, [expected], `${endpoint} flag=${flag}`);
    }
  }
  assert.equal(otlp.otlpLogsUrl(ENDPOINT), `${ENDPOINT}/v1/logs`);
});

test("endpointIsFull posts to the endpoint exactly as written, for send and test", async () => {
  const full = "https://collector.example.com/ingest/logs?tenant=red";
  const { urls, httpFetch } = collector();
  const client = otlp.createOtlpClientForTest(
    { ...base, endpoint: full, endpointIsFull: true },
    httpFetch
  );
  await client.send([minimalRecord]);
  assert.equal((await client.test()).ok, true);
  assert.deepEqual(urls, [full, full]);
  assert.equal(otlp.otlpLogsUrl(`${ENDPOINT}/custom/`, true), `${ENDPOINT}/custom/`);
});

test("the schema accepts the flag, defaults it off, and the form field starts unchecked", () => {
  assert.equal(otlp.otlpConfigSchema.safeParse({ endpoint: ENDPOINT }).success, true);
  assert.equal(
    otlp.otlpConfigSchema.safeParse({ endpoint: ENDPOINT, endpointIsFull: true }).success,
    true
  );
  assert.equal(
    otlp.otlpConfigSchema.safeParse({ endpoint: ENDPOINT, endpointIsFull: "yes" }).success,
    false
  );
  const field = registry
    .describeLogExportDestinationTypes()
    .find((d) => d.id === "otlp")
    ?.fields.find((f) => f.key === "endpointIsFull");
  assert.equal(field?.type, "boolean");
  assert.equal(field?.defaultValue, false);
});

// --- route -------------------------------------------------------------------------------------

test("GET /api/log-export/otlp-templates serves the presets in a fixed shape", async () => {
  const response = await route.GET(new Request("http://localhost/api/log-export/otlp-templates"));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { templates: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(body), ["templates"]);
  assert.equal(body.templates.length, templates.OTLP_TEMPLATES.length);
  for (const template of body.templates) {
    assert.deepEqual(Object.keys(template).sort(), [
      "docsUrl",
      "endpoint",
      "endpointIsFull",
      "headers",
      "id",
      "label",
      "notes",
      "placeholders",
      "verified",
    ]);
  }
  assert.equal("PUT" in route || "POST" in route || "DELETE" in route, false);
});
