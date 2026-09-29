import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "redrouter-usage-sinks-api-"));
process.env.DATA_DIR = dataDir;
process.env.STORAGE_ENCRYPTION_KEY = "usage-sinks-api-test-key-0123456789";
process.env.API_KEY_SECRET = "usage-sinks-api-test-api-key-secret";

const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
const { decrypt } = await import("../../../src/lib/db/encryption.ts");
const { recordLedgerEntry } = await import("../../../src/lib/db/costLedger.ts");
const store = await import("../../../src/lib/db/usageSinks.ts");
const engine = await import("../../../src/lib/usageSinks/engine.ts");
const { resetKafkaProducers } = await import("../../../src/lib/usageSinks/transports/kafka.ts");
const sinksRoute = await import("../../../src/app/api/usage-sinks/route.ts");
const sinkRoute = await import("../../../src/app/api/usage-sinks/[id]/route.ts");
const testRoute = await import("../../../src/app/api/usage-sinks/[id]/test/route.ts");
const deliveriesRoute = await import("../../../src/app/api/usage-sinks/[id]/deliveries/route.ts");
const retryRoute =
  await import("../../../src/app/api/usage-sinks/[id]/deliveries/[deliveryId]/retry/route.ts");
const typesRoute = await import("../../../src/app/api/usage-sinks/types/route.ts");
const keySearchRoute = await import("../../../src/app/api/keys/search/route.ts");

type Sink = Record<string, unknown> & { id: string };

const json = (method: string, body?: unknown) =>
  new Request("http://localhost/api/usage-sinks", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });
const create = async (body: unknown) => {
  const response = await sinksRoute.POST(json("POST", body));
  return {
    status: response.status,
    body: (await response.json()) as { sink?: Sink; error?: unknown },
  };
};
const patch = async (id: string, body: unknown) => {
  const response = await sinkRoute.PATCH(json("PATCH", body), ctx({ id }));
  return {
    status: response.status,
    body: (await response.json()) as { sink?: Sink; error?: unknown },
  };
};

const SECRETS = [
  "whsec-SECRET-webhook-0123456789",
  "SECRET-aws-secret-access-key",
  "SECRET-aws-session-token",
  "SECRET-kafka-password",
  "SECRET-reddb-token",
];
const leaks = (value: unknown) =>
  SECRETS.filter((secret) => JSON.stringify(value).includes(secret));

const configs = {
  webhook: { url: "https://billing.example.test/hook", secret: SECRETS[0] },
  sqs: {
    queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/usage.fifo",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: SECRETS[1],
    sessionToken: SECRETS[2],
  },
  kafka: {
    brokers: "k1.example.test:9092, k2.example.test:9092",
    topic: "redrouter.usage",
    ssl: true,
    saslMechanism: "scram-sha-256",
    saslUsername: "billing",
    saslPassword: SECRETS[3],
  },
  reddb: { url: "https://reddb.example.test", queue: "usage_events", token: SECRETS[4] },
} as const;

/** A stand-in for an SQS or RedDB endpoint on loopback, to exercise the real guarded fetch. */
async function startStub() {
  const hits: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];
  const reply = { status: 200, body: "{}" };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      hits.push({ url: req.url ?? "", headers: req.headers, body });
      res.writeHead(reply.status, { "content-type": "application/json" }).end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    hits,
    reply,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("configuration and secrets", () => {
  test("every transport can be created; no response carries a credential; each is encrypted at rest", async () => {
    for (const [type, config] of Object.entries(configs)) {
      const { status, body } = await create({
        name: `${type} sink`,
        type,
        mode: "instant",
        config,
      });
      assert.equal(status, 201, `${type}: ${JSON.stringify(body.error)}`);
      assert.deepEqual(leaks(body), [], `${type} response`);
      const stored = store.getUsageSink(body.sink!.id)!;
      assert.equal(stored.type, type);
      assert.deepEqual(leaks(stored.config), [], `${type} row is not plaintext`);
      for (const secretKey of Object.keys(stored.config).filter((key) =>
        /secret|token|password/i.test(key)
      )) {
        assert.match(String(stored.config[secretKey]), /^enc:v1:/, `${type}.${secretKey}`);
      }
    }
    const list = await (await sinksRoute.GET(json("GET"))).json();
    assert.equal(list.sinks.length, 4);
    assert.deepEqual(leaks(list), []);
    const sqs = list.sinks.find((sink: Sink) => sink.type === "sqs");
    assert.equal(sqs.config.secretAccessKey, "__stored__");
    assert.equal(sqs.config.accessKeyId, "AKIDEXAMPLE");
    assert.equal(sqs.config.region, "us-east-1");
    assert.match(sqs.summary, /^SQS usage\.fifo \(us-east-1\)$/);
    assert.deepEqual(sqs.deliveries, { pending: 0, delivered: 0, dead: 0 });
    const kafka = list.sinks.find((sink: Sink) => sink.type === "kafka");
    assert.deepEqual(kafka.config.brokers, ["k1.example.test:9092", "k2.example.test:9092"]);
    assert.equal(kafka.config.saslPassword, "__stored__");
    assert.equal(kafka.summary, "Kafka redrouter.usage @ k1.example.test:9092 +1");
    // GET /{id} is redacted too.
    const one = await (await sinkRoute.GET(json("GET"), ctx({ id: sqs.id }))).json();
    assert.deepEqual(leaks(one), []);
  });

  test("the original webhook-only body still works, and stays public HTTPS", async () => {
    const legacy = await create({
      name: "legacy",
      mode: "window",
      windowSec: 900,
      url: "https://legacy.example.test/usage",
      secret: "legacy-secret-0123456789",
    });
    assert.equal(legacy.status, 201);
    assert.equal(legacy.body.sink!.type, "webhook");
    assert.equal(legacy.body.sink!.secret, "__stored__");
    assert.equal(legacy.body.sink!.url, "https://legacy.example.test/usage");
    const local = await create({
      name: "x",
      mode: "instant",
      url: "https://127.0.0.1/u",
      secret: "0123456789abcdef",
    });
    assert.equal(local.status, 400);
    const plain = await create({
      name: "x",
      mode: "instant",
      url: "http://billing.example.test/u",
      secret: "0123456789abcdef",
    });
    assert.equal(plain.status, 400);
  });

  test("validation and the egress policy are enforced at create time", async () => {
    const bad = async (body: unknown) => (await create(body)).status;
    assert.equal(
      await bad({ name: "x", type: "carrier-pigeon", mode: "instant", config: {} }),
      400
    );
    assert.equal(
      await bad({
        name: "x",
        type: "kafka",
        mode: "instant",
        config: { brokers: "nohost", topic: "t" },
      }),
      400
    );
    assert.equal(
      await bad({
        name: "x",
        type: "kafka",
        mode: "instant",
        config: { brokers: "169.254.169.254:9092", topic: "t" },
      }),
      400
    );
    assert.equal(
      await bad({
        name: "x",
        type: "reddb",
        mode: "instant",
        config: { url: "http://127.0.0.1:5000", queue: "q" },
      }),
      400
    );
    assert.equal(
      await bad({
        name: "x",
        type: "reddb",
        mode: "instant",
        config: { url: "https://reddb.example.test", queue: "1bad" },
      }),
      400
    );
    assert.equal(
      await bad({
        name: "x",
        type: "sqs",
        mode: "instant",
        config: {
          queueUrl: "http://169.254.169.254/1/q",
          region: "us-east-1",
          accessKeyId: "A",
          secretAccessKey: "S",
        },
      }),
      400
    );
    assert.equal(
      await bad({
        name: "x",
        type: "sqs",
        mode: "instant",
        config: { ...configs.sqs, accessKeyId: "" },
      }),
      400
    );
    assert.equal(
      await bad({
        name: "x",
        mode: "window",
        windowSec: 42,
        url: "https://b.example.test",
        secret: "0123456789abcdef",
      }),
      400
    );
    assert.equal(
      await bad({
        name: "x",
        type: "reddb",
        mode: "instant",
        config: configs.reddb,
        surprise: true,
      }),
      400
    );
    // A body that fails the schema keeps the details shape; a bad transport config is a message.
    const shape = (
      await create({ name: "x", mode: "window", windowSec: 42, config: configs.reddb })
    ).body.error;
    assert.equal(typeof shape, "object");
    const config = (
      await create({
        name: "x",
        type: "kafka",
        mode: "instant",
        config: { brokers: "nohost", topic: "t" },
      })
    ).body.error;
    assert.match(String(config), /Invalid Kafka configuration \(brokers/);
  });

  test("credentials are refused, not stored in plaintext, when no encryption key is configured", async () => {
    const key = process.env.STORAGE_ENCRYPTION_KEY;
    delete process.env.STORAGE_ENCRYPTION_KEY;
    try {
      const { status, body } = await create({
        name: "no key",
        type: "reddb",
        mode: "instant",
        config: configs.reddb,
      });
      assert.equal(status, 400);
      assert.match(String(body.error), /STORAGE_ENCRYPTION_KEY/);
    } finally {
      process.env.STORAGE_ENCRYPTION_KEY = key;
    }
  });

  test("an edit keeps stored credentials unless they are replaced or cleared", async () => {
    const created = (
      await create({ name: "edit me", type: "sqs", mode: "instant", config: configs.sqs })
    ).body.sink!;
    const plain = (key: string) => {
      const value = store.getUsageSink(created.id)!.config[key];
      return typeof value === "string" ? decrypt(value) : value;
    };

    // Omitted and placeholder credentials keep their stored value (re-encrypted, so the
    // ciphertext changes but the plaintext does not).
    const kept = await patch(created.id, {
      config: {
        queueUrl: configs.sqs.queueUrl,
        accessKeyId: "AKIDROTATED",
        secretAccessKey: "__stored__",
      },
    });
    assert.equal(kept.status, 200, JSON.stringify(kept.body.error));
    assert.equal(plain("accessKeyId"), "AKIDROTATED");
    assert.equal(plain("secretAccessKey"), SECRETS[1]);
    assert.equal(plain("sessionToken"), SECRETS[2]);

    // New plaintext replaces it; an empty value clears an optional credential.
    const replaced = await patch(created.id, {
      config: { ...configs.sqs, secretAccessKey: "SECRET-aws-rotated", sessionToken: "" },
    });
    assert.equal(replaced.status, 200);
    assert.equal(plain("secretAccessKey"), "SECRET-aws-rotated");
    assert.match(String(store.getUsageSink(created.id)!.config.secretAccessKey), /^enc:v1:/);
    assert.equal(plain("sessionToken"), undefined);
    assert.deepEqual(JSON.stringify(replaced.body).includes("SECRET-aws-rotated"), false);

    // A required credential cannot be blanked, and the type never changes.
    assert.equal(
      (await patch(created.id, { config: { ...configs.sqs, secretAccessKey: "" } })).status,
      400
    );
    assert.equal((await patch(created.id, { type: "kafka" })).status, 400);
    assert.equal((await patch("missing", { name: "x" })).status, 404);
  });

  test("changing the mode reschedules the window without moving the cursor", async () => {
    const created = (
      await create({
        name: "sched",
        type: "reddb",
        mode: "window",
        windowSec: 300,
        enabled: true,
        config: configs.reddb,
      })
    ).body.sink!;
    engine.aggregateUsageSink(store.getUsageSink(created.id)!, new Date("2026-09-28T10:00:00Z"));
    assert.ok(store.getUsageSink(created.id)!.nextWindowEnd);
    const cursor = store.getUsageSink(created.id)!.cursorId;
    const updated = (await patch(created.id, { windowSec: 900 })).body.sink!;
    assert.equal(updated.windowSec, 900);
    assert.equal(updated.nextWindowEnd, null);
    assert.equal(store.getUsageSink(created.id)!.cursorId, cursor);
    const instant = (await patch(created.id, { mode: "instant" })).body.sink!;
    assert.equal(instant.windowSec, null);
  });

  test("the transport descriptors drive the dashboard form", async () => {
    const body = await (await typesRoute.GET(json("GET"))).json();
    assert.deepEqual(
      body.types.map((type: { type: string }) => type.type),
      ["webhook", "sqs", "kafka", "reddb"]
    );
    assert.deepEqual(body.windowSizesSec, [300, 900, 1800, 3600]);
  });
});

describe("delivery: stable message identity, retries", () => {
  // Deliveries are due from the real commit time, so the engine clock starts just after it.
  const NOW = new Date(Date.now() + 1000);
  const fakeKafka = () => {
    const sent: Array<{
      topic: string;
      messages: Array<{ key: string; headers: Record<string, string> }>;
    }> = [];
    return {
      sent,
      kafkaFactory: async () => ({
        producer: () => ({
          connect: async () => {},
          disconnect: async () => {},
          send: async (record: (typeof sent)[number]) => {
            sent.push(record);
            return [{ partition: 0, baseOffset: "7" }];
          },
        }),
      }),
    };
  };

  test("a retried delivery carries the same id on every transport, and is never re-created", async () => {
    resetKafkaProducers();
    const key = await createApiKey("Billing customer", "machine-1");
    const reddb = (
      await create({
        name: "rq",
        type: "reddb",
        mode: "instant",
        enabled: true,
        config: configs.reddb,
        apiKeyIds: [key.id],
      })
    ).body.sink!;
    const kafka = (
      await create({
        name: "kq",
        type: "kafka",
        mode: "instant",
        enabled: true,
        config: configs.kafka,
        apiKeyIds: [key.id],
      })
    ).body.sink!;
    const sqs = (
      await create({
        name: "sq",
        type: "sqs",
        mode: "instant",
        enabled: true,
        config: configs.sqs,
        apiKeyIds: [key.id],
      })
    ).body.sink!;
    recordLedgerEntry({
      apiKeyId: key.id,
      provider: "openai",
      model: "m",
      tokensInput: 10,
      tokensOutput: 5,
      amountUsd: 0.5,
      requestId: "req-identity",
    });
    for (const sink of [reddb, kafka, sqs])
      engine.aggregateUsageSink(store.getUsageSink(sink.id)!, NOW);
    for (const sink of [reddb, kafka, sqs])
      assert.equal(store.listUsageDeliveries(sink.id).length, 1);

    const calls: Array<{ url: string; body: string }> = [];
    let status = 503;
    const httpFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status });
    };
    const kafkaDeps = fakeKafka();
    const deps = { httpFetch, kafkaFactory: kafkaDeps.kafkaFactory };

    // First round: the HTTP transports fail (503), Kafka lands.
    assert.equal(await engine.dispatchUsageDeliveries(NOW, deps), 3);
    const [redbFirst] = store.listUsageDeliveries(reddb.id);
    assert.equal(redbFirst.status, "pending");
    assert.equal(redbFirst.attempts, 1);
    assert.equal(redbFirst.lastStatus, 503);
    assert.equal(redbFirst.nextAttemptAt, new Date(NOW.getTime() + 30_000).toISOString());
    assert.equal(store.listUsageDeliveries(kafka.id)[0].status, "delivered");
    // Nothing is due before the backoff elapses.
    assert.equal(await engine.dispatchUsageDeliveries(new Date(NOW.getTime() + 1000), deps), 0);

    // Second round after the backoff: same delivery ids, now accepted.
    status = 200;
    const later = new Date(NOW.getTime() + 31_000);
    assert.equal(await engine.dispatchUsageDeliveries(later, deps), 2);
    const id = (sinkId: string) => store.listUsageDeliveries(sinkId)[0].id;
    for (const sink of [reddb, kafka, sqs]) {
      assert.equal(store.listUsageDeliveries(sink.id)[0].status, "delivered", sink.id);
      assert.match(id(sink.id), /^ue_[0-9a-f]{24}$/);
    }

    const redbBodies = calls
      .filter((call) => call.url.endsWith("/query"))
      .map((call) => JSON.parse(call.body).query);
    assert.equal(redbBodies.length, 2);
    for (const query of redbBodies) assert.ok(query.endsWith(`DEDUP '${id(reddb.id)}'`), query);
    const sqsBodies = calls
      .filter((call) => call.url.startsWith("https://sqs."))
      .map((call) => JSON.parse(call.body));
    assert.equal(sqsBodies.length, 2);
    for (const message of sqsBodies) {
      assert.equal(message.MessageDeduplicationId, id(sqs.id));
      assert.equal(message.MessageGroupId, sqs.id);
      assert.equal(message.MessageAttributes["redrouter-delivery-id"].StringValue, id(sqs.id));
    }
    assert.equal(kafkaDeps.sent.length, 1);
    assert.equal(kafkaDeps.sent[0].messages[0].key, kafka.id);
    assert.equal(kafkaDeps.sent[0].messages[0].headers["redrouter-delivery-id"], id(kafka.id));

    // Aggregating again neither re-creates nor changes anything.
    for (const sink of [reddb, kafka, sqs])
      assert.equal(engine.aggregateUsageSink(store.getUsageSink(sink.id)!, later), 0);
    assert.equal(id(reddb.id), redbFirst.id);
    for (const sink of [reddb, kafka, sqs])
      assert.equal(store.listUsageDeliveries(sink.id).length, 1);
  });

  test("a permanent failure is dead at once; running out of retries is dead too", async () => {
    const sink = (
      await create({
        name: "dead",
        type: "webhook",
        mode: "instant",
        enabled: true,
        config: configs.webhook,
      })
    ).body.sink!;
    recordLedgerEntry({
      apiKeyId: "key-dead",
      provider: "openai",
      model: "m",
      amountUsd: 0.1,
      requestId: "req-dead",
    });
    engine.aggregateUsageSink(store.getUsageSink(sink.id)!, NOW);
    const gone = { httpFetch: async () => new Response(null, { status: 410 }) };
    await engine.dispatchUsageDeliveries(NOW, gone);
    const [delivery] = store.listUsageDeliveries(sink.id);
    assert.equal(delivery.status, "dead", JSON.stringify(delivery.lastError));
    assert.equal(delivery.lastStatus, 410);
    assert.equal(delivery.lastError, "HTTP 410");
    assert.equal(delivery.nextAttemptAt, null);
  });
});

describe("dashboard API against a live endpoint", () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  let sink: Sink;
  before(async () => {
    stub = await startStub();
    // The stub is on loopback: reaching it needs the operator's private-URL opt-in.
    process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS = "true";
    sink = (
      await create({
        name: "live",
        type: "reddb",
        mode: "instant",
        enabled: true,
        config: { url: stub.origin, queue: "usage_events", token: "SECRET-reddb-token" },
      })
    ).body.sink!;
  });
  after(async () => {
    delete process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;
    await stub.close();
  });

  const post = (path: string, id: string, deliveryId?: string, body?: unknown) =>
    path === "test"
      ? testRoute.POST(json("POST", body ?? {}), ctx({ id }))
      : retryRoute.POST(json("POST"), ctx({ id, deliveryId: deliveryId! }));

  test("Send test delivers a sample marked test, with the stored credential, outside the outbox", async () => {
    const before = store.getUsageSink(sink.id)!.cursorId;
    const response = await post("test", sink.id);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.valid, true);
    assert.deepEqual(Object.keys(result.probe).sort(), [
      "bytes",
      "durationMs",
      "error",
      "method",
      "status",
      "statusText",
      "url",
    ]);
    assert.equal(result.probe.url, `${stub.origin}/query`);
    const hit = stub.hits.at(-1)!;
    assert.equal(hit.headers.authorization, "Bearer SECRET-reddb-token");
    const statement = JSON.parse(hit.body).query as string;
    assert.match(statement, /^QUEUE PUSH usage_events \{.*\} DEDUP 'test_[0-9a-f-]{36}'$/);
    assert.match(statement, /"type":"usage\.recorded"/);
    assert.match(statement, /"test":true/);
    assert.equal(store.getUsageSink(sink.id)!.cursorId, before);
    assert.equal(store.listUsageDeliveries(sink.id).length, 0);
    assert.deepEqual(leaks(result), []);
  });

  test("Send test uses unsaved form values, keeps a credential left out, and reports failures", async () => {
    stub.reply.status = 422;
    stub.reply.body = JSON.stringify({ ok: false, error: "queue 'other' not found" });
    const response = await post("test", sink.id, undefined, {
      config: { url: stub.origin, queue: "other" },
    });
    const result = await response.json();
    assert.equal(result.valid, false);
    assert.equal(result.error, "HTTP 422: queue 'other' not found");
    assert.equal(result.probe.status, 422);
    assert.match(String(JSON.parse(stub.hits.at(-1)!.body).query), /^QUEUE PUSH other /);
    assert.equal(stub.hits.at(-1)!.headers.authorization, "Bearer SECRET-reddb-token");
    assert.equal(
      store.getUsageSink(sink.id)!.config.queue,
      "usage_events",
      "the stored sink is untouched"
    );
    stub.reply.status = 200;
    stub.reply.body = "{}";
    // An invalid unsaved config is answered like a failed test, not a crash.
    const invalid = await (
      await post("test", sink.id, undefined, { config: { url: stub.origin, queue: "1bad" } })
    ).json();
    assert.equal(invalid.valid, false);
    assert.match(invalid.error, /queue/);
    assert.equal((await post("test", "missing")).status, 404);
  });

  test("a webhook test never reaches a private address, even with the opt-in on", async () => {
    const webhook = (
      await create({
        name: "wh",
        type: "webhook",
        mode: "instant",
        config: { url: "https://billing.example.test/hook", secret: SECRETS[0] },
      })
    ).body.sink!;
    const sinkRow = store.getUsageSink(webhook.id)!;
    // Point the stored webhook at loopback behind the validator's back to prove the send-time guard.
    const { getDbInstance } = await import("../../../src/lib/db/core.ts");
    getDbInstance()
      .prepare("UPDATE redrouter_usage_sinks SET config = ? WHERE id = ?")
      .run(JSON.stringify({ ...sinkRow.config, url: `${stub.origin}/hook` }), webhook.id);
    const before = stub.hits.length;
    const result = await (await post("test", webhook.id)).json();
    assert.equal(result.valid, false);
    assert.equal(stub.hits.length, before, "nothing was sent");
  });

  test("deliveries are paged, filterable, and never expose the payload", async () => {
    for (let i = 0; i < 5; i++) {
      recordLedgerEntry({
        apiKeyId: "key-page",
        provider: "openai",
        model: "m",
        amountUsd: 0.01,
        requestId: `page-${i}`,
      });
    }
    engine.aggregateUsageSink(store.getUsageSink(sink.id)!, new Date("2026-09-28T13:00:00Z"));
    const list = async (query: string) => {
      const response = await deliveriesRoute.GET(
        new Request(`http://localhost/api/usage-sinks/${sink.id}/deliveries?${query}`),
        ctx({ id: sink.id })
      );
      return { status: response.status, body: await response.json() };
    };
    const first = await list("page=1&pageSize=2");
    assert.equal(first.body.total, 5);
    assert.equal(first.body.deliveries.length, 2);
    assert.deepEqual([first.body.page, first.body.pageSize], [1, 2]);
    const third = await list("page=3&pageSize=2");
    assert.equal(third.body.deliveries.length, 1);
    const delivery = first.body.deliveries[0];
    assert.equal("payload" in delivery, false);
    assert.equal(delivery.kind, "event");
    assert.equal(delivery.requests, 1);
    assert.equal(delivery.status, "pending");
    assert.equal((await list("status=delivered")).body.total, 0);
    assert.equal((await list("status=pending")).body.total, 5);
    assert.equal((await list("pageSize=1000")).status, 400);
    assert.equal((await deliveriesRoute.GET(json("GET"), ctx({ id: "missing" }))).status, 404);
  });

  test("retry sends a dead delivery again with the same id and a fresh budget", async () => {
    const [target] = store.listUsageDeliveries(sink.id, 1);
    // Kill it the way the schedule would: out of attempts.
    const { getDbInstance } = await import("../../../src/lib/db/core.ts");
    getDbInstance()
      .prepare(
        "UPDATE redrouter_usage_deliveries SET status = 'dead', attempts = 9, next_attempt_at = NULL, last_error = 'HTTP 500' WHERE id = ?"
      )
      .run(target.id);
    const hitsBefore = stub.hits.length;
    const response = await post("retry", sink.id, target.id);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    const after = store.getUsageDelivery(sink.id, target.id)!;
    assert.equal(after.id, target.id);
    assert.equal(after.status, "delivered");
    assert.equal(after.attempts, 1, "a dead delivery restarts its retry budget");
    assert.equal(after.lastError, null);
    assert.equal(stub.hits.length, hitsBefore + 1);
    assert.ok(String(JSON.parse(stub.hits.at(-1)!.body).query).endsWith(`DEDUP '${target.id}'`));

    // Delivered deliveries are not sent twice; unknown and foreign ones are 404.
    assert.equal((await post("retry", sink.id, target.id)).status, 409);
    assert.equal(stub.hits.length, hitsBefore + 1);
    assert.equal((await post("retry", sink.id, "nope")).status, 404);
    const other = (
      await create({ name: "other", type: "reddb", mode: "instant", config: configs.reddb })
    ).body.sink!;
    assert.equal((await post("retry", other.id, target.id)).status, 404);
  });

  test("retry of a failing delivery reports the failure and keeps it retryable", async () => {
    const pending = store
      .listUsageDeliveries(sink.id, 10)
      .find((delivery) => delivery.status === "pending")!;
    stub.reply.status = 500;
    stub.reply.body = JSON.stringify({ ok: false, error: "boom" });
    const result = await (await post("retry", sink.id, pending.id)).json();
    stub.reply.status = 200;
    stub.reply.body = "{}";
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
    assert.equal(result.error, "HTTP 500: boom");
    assert.equal(String(result.error).includes("at /"), false, "no stack traces in error text");
    const after = store.getUsageDelivery(sink.id, pending.id)!;
    assert.equal(after.status, "pending");
    assert.equal(after.attempts, pending.attempts + 1);
    assert.ok(after.nextAttemptAt);
  });

  test("a delivery another worker holds a live lease on is not sent twice", async () => {
    const pending = store
      .listUsageDeliveries(sink.id, 10)
      .find((delivery) => delivery.status === "pending")!;
    // Another worker claims it (in the far future, past its backoff) and holds the lease.
    assert.equal(
      store.claimUsageDelivery(pending.id, "2100-01-01T00:00:00.000Z", "2100-01-01T00:01:00.000Z"),
      true
    );
    const hitsBefore = stub.hits.length;
    assert.equal((await post("retry", sink.id, pending.id)).status, 409);
    assert.equal(stub.hits.length, hitsBefore);
  });
});

describe("API key picker", () => {
  test("searches keys by name a page at a time and never returns the key", async () => {
    for (const name of ["Acme prod", "Acme staging", "Globex"])
      await createApiKey(name, "machine-1");
    const search = async (query: string) =>
      (await keySearchRoute.GET(new Request(`http://localhost/api/keys/search?${query}`))).json();
    const acme = await search("q=acme");
    assert.equal(acme.total, 2);
    assert.deepEqual(
      acme.keys.map((key: { name: string }) => key.name),
      ["Acme prod", "Acme staging"]
    );
    assert.deepEqual(Object.keys(acme.keys[0]).sort(), ["id", "name"]);
    const page = await search("limit=1&offset=1");
    assert.equal(page.keys.length, 1);
    assert.ok(page.total >= 4);
    assert.equal((await search("q=%25")).total, 0, "LIKE wildcards are matched literally");
    assert.equal(
      (await keySearchRoute.GET(new Request("http://localhost/api/keys/search?limit=9999"))).status,
      400
    );
  });

  test("the sink list names the keys a sink filters on, and marks deleted ones", async () => {
    const key = await createApiKey("Initech", "machine-1");
    const filtered = (
      await create({
        name: "filtered",
        type: "reddb",
        mode: "instant",
        config: configs.reddb,
        apiKeyIds: [key.id, "gone"],
      })
    ).body.sink!;
    const list = await (await sinksRoute.GET(json("GET"))).json();
    const entry = list.sinks.find((item: Sink) => item.id === filtered.id);
    assert.deepEqual(entry.filterKeys, [
      { id: key.id, name: "Initech" },
      { id: "gone", name: null, deleted: true },
    ]);
  });
});
