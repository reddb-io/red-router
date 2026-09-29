import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { beforeEach, describe, test } from "node:test";

// Transports run against injected fetch / Kafka clients: nothing here touches the network.
const { webhookTransport, signUsageWebhook } =
  await import("../../../src/lib/usageSinks/transports/webhook.ts");
const { sqsTransport, regionFromQueueUrl, SQS_MAX_MESSAGE_BYTES } =
  await import("../../../src/lib/usageSinks/transports/sqs.ts");
const { kafkaTransport, resetKafkaProducers, createGuardedLookup, isBlockedBrokerAddress } =
  await import("../../../src/lib/usageSinks/transports/kafka.ts");
const { redDbTransport, queuePushStatement, REDDB_MAX_STATEMENT_BYTES } =
  await import("../../../src/lib/usageSinks/transports/reddb.ts");
const { TRANSPORTS, getTransport, describeTransports } =
  await import("../../../src/lib/usageSinks/transports/index.ts");

type Call = { url: string; init: RequestInit };
const recordingFetch = (status = 200, body = "{}") => {
  const calls: Call[] = [];
  const httpFetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(status === 204 ? null : body, { status });
  };
  return { calls, httpFetch };
};
const headersOf = (call: Call) => call.init.headers as Record<string, string>;
const bodyOf = (call: Call) => JSON.parse(String(call.init.body));

const NOW = Date.parse("2026-09-25T13:50:03Z");
const aws = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

describe("webhook transport", () => {
  const config = {
    url: "https://billing.example.test/hook",
    secret: "whsec_c2VjcmV0MTIzNDU2Nzg5MA==",
  };

  test("signs per Standard Webhooks with the delivery id as webhook-id", async () => {
    const { calls, httpFetch } = recordingFetch(204, "");
    const result = await webhookTransport.send(
      { config, id: "ub_1", sinkId: "sink1", payload: { a: 1 }, now: NOW },
      { httpFetch }
    );
    assert.equal(result.ok, true);
    const headers = headersOf(calls[0]);
    assert.equal(headers["webhook-id"], "ub_1");
    assert.equal(headers["webhook-timestamp"], String(Math.floor(NOW / 1000)));
    assert.equal(
      headers["webhook-signature"],
      signUsageWebhook("ub_1", headers["webhook-timestamp"], '{"a":1}', config.secret)
    );
    // A receiver verifying per the spec: HMAC-SHA256 over "id.timestamp.body" keyed with the
    // decoded whsec_ bytes, base64, prefixed v1.
    const expected = createHmac("sha256", Buffer.from(config.secret.slice(6), "base64"))
      .update(`ub_1.${headers["webhook-timestamp"]}.{"a":1}`)
      .digest("base64");
    assert.equal(headers["webhook-signature"], `v1,${expected}`);
  });

  test("410 Gone stops retries, other HTTP failures keep them", async () => {
    const gone = await webhookTransport.send(
      { config, id: "ub_1", sinkId: "s", payload: {}, now: NOW },
      recordingFetch(410)
    );
    assert.deepEqual([gone.ok, gone.retryable, gone.error], [false, false, "HTTP 410"]);
    const busy = await webhookTransport.send(
      { config, id: "ub_1", sinkId: "s", payload: {}, now: NOW },
      recordingFetch(503)
    );
    assert.deepEqual([busy.ok, busy.retryable, busy.error], [false, true, "HTTP 503"]);
  });

  test("only public HTTPS URLs are accepted", () => {
    const parse = (url: string) =>
      webhookTransport.configSchema.safeParse({ url, secret: config.secret });
    assert.equal(parse("https://billing.example.test/hook").success, true);
    assert.equal(parse("http://billing.example.test/hook").success, false);
    assert.equal(parse("https://127.0.0.1/hook").success, false);
    assert.equal(parse("https://169.254.169.254/latest").success, false);
    assert.equal(parse("https://user:pass@billing.example.test/").success, false);
    assert.equal(
      webhookTransport.configSchema.safeParse({ url: config.url, secret: "short" }).success,
      false
    );
  });
});

describe("SQS transport", () => {
  const standard = {
    queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/usage",
    region: "us-east-1",
    ...aws,
  };
  const fifo = { ...standard, queueUrl: `${standard.queueUrl}.fifo` };

  test("signs with SigV4 and carries the delivery id as a message attribute", async () => {
    const { calls, httpFetch } = recordingFetch();
    const result = await sqsTransport.send(
      {
        config: { ...standard, sessionToken: "tok123" },
        id: "ub_1",
        sinkId: "sink1",
        payload: { a: 1 },
        now: NOW,
      },
      { httpFetch }
    );
    assert.equal(result.ok, true);
    assert.equal(calls[0].url, "https://sqs.us-east-1.amazonaws.com/");
    const headers = headersOf(calls[0]);
    assert.equal(headers["x-amz-target"], "AmazonSQS.SendMessage");
    assert.equal(headers["x-amz-security-token"], "tok123");
    assert.equal(headers["x-amz-date"], "20260925T135003Z");
    assert.match(
      headers.Authorization,
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260925\/us-east-1\/sqs\/aws4_request, SignedHeaders=.*x-amz-target, Signature=[0-9a-f]{64}$/
    );
    assert.equal("host" in headers, false, "the Host header is left to fetch");
    const body = bodyOf(calls[0]);
    assert.equal(body.MessageBody, '{"a":1}');
    assert.equal(body.MessageAttributes["redrouter-delivery-id"].StringValue, "ub_1");
    assert.equal("MessageDeduplicationId" in body, false, "standard queues have no dedup id");
  });

  test("a FIFO queue deduplicates on the delivery id and orders per sink", async () => {
    const first = recordingFetch();
    const retry = recordingFetch();
    for (const { httpFetch } of [first, retry]) {
      await sqsTransport.send(
        { config: fifo, id: "ub_1", sinkId: "sink1", payload: { a: 1 }, now: NOW },
        { httpFetch }
      );
    }
    // The same delivery, sent again after a failure, is enqueued under the same dedup id.
    assert.deepEqual(
      [bodyOf(first.calls[0]).MessageDeduplicationId, bodyOf(first.calls[0]).MessageGroupId],
      ["ub_1", "sink1"]
    );
    assert.equal(bodyOf(retry.calls[0]).MessageDeduplicationId, "ub_1");
  });

  test("reports the SQS error type and keeps retrying", async () => {
    const result = await sqsTransport.send(
      { config: standard, id: "ub_1", sinkId: "s", payload: {}, now: NOW },
      recordingFetch(
        400,
        JSON.stringify({
          __type: "com.amazonaws.sqs#QueueDoesNotExist",
          message: "The specified queue does not exist.",
        })
      )
    );
    assert.deepEqual(
      [result.ok, result.retryable, result.status, result.error],
      [false, true, 400, "HTTP 400: QueueDoesNotExist: The specified queue does not exist."]
    );
  });

  test("a payload over the 256 KiB SQS limit is a permanent failure and is not sent", async () => {
    const { calls, httpFetch } = recordingFetch();
    const result = await sqsTransport.send(
      {
        config: standard,
        id: "ub_1",
        sinkId: "s",
        payload: { x: "y".repeat(SQS_MAX_MESSAGE_BYTES) },
        now: NOW,
      },
      { httpFetch }
    );
    assert.deepEqual([result.ok, result.retryable], [false, false]);
    assert.equal(calls.length, 0);
  });

  test("validates the endpoint and credentials", () => {
    const parse = (config: Record<string, unknown>) => sqsTransport.configSchema.safeParse(config);
    assert.equal(regionFromQueueUrl("https://sqs.sa-east-1.amazonaws.com/1/q"), "sa-east-1");
    assert.equal(regionFromQueueUrl("http://localhost:4566/000000000000/q"), null);
    const derived = parse(standard);
    assert.equal(derived.success && derived.data.region, "us-east-1");
    assert.equal(parse({ ...standard, region: "" }).success, true, "region comes from the AWS URL");
    // Outside amazonaws.com the region cannot be guessed, and a private endpoint needs the opt-in.
    assert.equal(
      parse({ ...standard, queueUrl: "https://sqs.example.test/1/q", region: "" }).success,
      false
    );
    assert.equal(parse({ ...standard, queueUrl: "https://sqs.example.test/1/q" }).success, true);
    assert.equal(
      parse({ ...standard, queueUrl: "http://localhost:4566/0/q", region: "us-east-1" }).success,
      false
    );
    assert.equal(
      parse({ ...standard, queueUrl: "http://169.254.169.254/0/q", region: "us-east-1" }).success,
      false
    );
    assert.equal(
      parse({ ...standard, queueUrl: standard.queueUrl.replace("https", "http") }).success,
      false
    );
    assert.equal(parse({ ...standard, accessKeyId: "" }).success, false);
    assert.equal(parse({ queueUrl: standard.queueUrl }).success, false);
  });
});

describe("Kafka transport", () => {
  beforeEach(() => resetKafkaProducers());

  const config = {
    brokers: ["k1.example.test:9092"],
    topic: "usage",
    clientId: "red-router",
    ssl: false,
  };
  const fakeKafka = ({ failSend = false } = {}) => {
    const sent: unknown[] = [];
    const state = { disconnects: 0, factories: 0 };
    const producer = {
      connect: async () => {},
      disconnect: async () => {
        state.disconnects++;
      },
      send: async (record: unknown) => {
        if (failSend) throw new Error("broker down");
        sent.push(record);
        return [{ partition: 2, baseOffset: "41" }];
      },
    };
    const kafkaFactory = async () => {
      state.factories++;
      return { producer: () => producer };
    };
    return { sent, state, kafkaFactory };
  };

  test("produces keyed by sink with the delivery id header, reusing the connection", async () => {
    const { sent, state, kafkaFactory } = fakeKafka();
    const first = await kafkaTransport.send(
      { config, id: "ub_1", sinkId: "sink1", payload: { a: 1 }, now: NOW },
      { kafkaFactory }
    );
    await kafkaTransport.send(
      { config, id: "ub_2", sinkId: "sink1", payload: {}, now: NOW },
      { kafkaFactory }
    );
    assert.equal(first.ok, true);
    assert.equal(first.statusText, "partition 2, offset 41");
    assert.equal(first.target, "kafka://k1.example.test:9092/usage");
    assert.equal(state.factories, 1);
    assert.deepEqual(sent[0], {
      topic: "usage",
      messages: [
        {
          key: "sink1",
          value: '{"a":1}',
          headers: { "redrouter-delivery-id": "ub_1", "content-type": "application/json" },
        },
      ],
    });
  });

  test("drops the producer after an error so the next attempt reconnects", async () => {
    const { state, kafkaFactory } = fakeKafka({ failSend: true });
    const result = await kafkaTransport.send(
      { config, id: "ub_1", sinkId: "s", payload: {}, now: NOW },
      { kafkaFactory }
    );
    assert.deepEqual([result.ok, result.retryable, result.error], [false, true, "broker down"]);
    assert.equal(state.disconnects, 1);
    await kafkaTransport.send(
      { config, id: "ub_1", sinkId: "s", payload: {}, now: NOW },
      { kafkaFactory }
    );
    assert.equal(state.factories, 2);
  });

  test("validates brokers, topic and SASL", () => {
    const parse = (extra: Record<string, unknown>) =>
      kafkaTransport.configSchema.safeParse({
        brokers: "k1.example.test:9092",
        topic: "usage",
        ...extra,
      });
    const ok = parse({ brokers: "k1.example.test:9092, k2.example.test:9093" });
    assert.deepEqual(ok.success && ok.data.brokers, [
      "k1.example.test:9092",
      "k2.example.test:9093",
    ]);
    assert.equal(parse({ brokers: "nohost" }).success, false);
    assert.equal(parse({ brokers: "k1.example.test:99999" }).success, false);
    assert.equal(parse({ topic: "bad topic" }).success, false);
    assert.equal(parse({ saslMechanism: "plain", saslUsername: "u" }).success, false);
    assert.equal(
      parse({ saslMechanism: "plain", saslUsername: "u", saslPassword: "p" }).success,
      true
    );
    assert.equal(
      parse({ saslMechanism: "gssapi", saslUsername: "u", saslPassword: "p" }).success,
      false
    );
    // Egress: metadata is never a broker, private addresses need the opt-in.
    assert.equal(parse({ brokers: "169.254.169.254:9092" }).success, false);
    assert.equal(parse({ brokers: "127.0.0.1:9092" }).success, false);
    assert.equal(parse({ brokers: "10.0.0.5:9092" }).success, false);
  });

  test("the guarded lookup refuses metadata and private answers, whatever the name", async () => {
    const answer = (address: string) =>
      createGuardedLookup((_host, _options, callback) => callback(null, [{ address, family: 4 }]));
    const lookup = (address: string, all = true) =>
      new Promise<{ error: Error | null; value: unknown }>((resolve) =>
        answer(address)("broker.example.test", { all }, (error, value) => resolve({ error, value }))
      );
    assert.match(
      (await lookup("169.254.169.254")).error?.message ?? "",
      /blocked by the egress policy/
    );
    assert.match((await lookup("10.1.2.3")).error?.message ?? "", /blocked by the egress policy/);
    assert.deepEqual((await lookup("93.184.216.34")).value, [
      { address: "93.184.216.34", family: 4 },
    ]);
    assert.equal((await lookup("93.184.216.34", false)).value, "93.184.216.34");
    assert.equal(isBlockedBrokerAddress("192.168.1.10"), true);
    assert.equal(isBlockedBrokerAddress("93.184.216.34"), false);
  });
});

describe("RedDB queue transport", () => {
  const config = {
    url: "https://reddb.example.test",
    queue: "usage",
    token: "rdb_k_x",
    tenant: "t1",
  };

  test("builds a QUEUE PUSH with the delivery id as the DEDUP key, quotes escaped", () => {
    assert.equal(
      queuePushStatement("usage", { a: "it's" }, "ub_'1"),
      `QUEUE PUSH usage {"a":"it's"} DEDUP 'ub_''1'`
    );
  });

  test("posts to /query with the token and tenant", async () => {
    const { calls, httpFetch } = recordingFetch(200, JSON.stringify({ ok: true }));
    const result = await redDbTransport.send(
      { config, id: "ub_1", sinkId: "s", payload: { a: 1 }, now: NOW },
      { httpFetch }
    );
    assert.equal(result.ok, true);
    assert.equal(calls[0].url, "https://reddb.example.test/query");
    assert.deepEqual(headersOf(calls[0]), {
      "content-type": "application/json",
      "user-agent": "RedRouter-UsageSinks/1",
      authorization: "Bearer rdb_k_x",
      "x-reddb-tenant": "t1",
    });
    assert.deepEqual(bodyOf(calls[0]), { query: `QUEUE PUSH usage {"a":1} DEDUP 'ub_1'` });
  });

  test("fails on ok:false and on statements over RedDB's 1 MiB limit", async () => {
    const rejected = await redDbTransport.send(
      { config, id: "ub_1", sinkId: "s", payload: {}, now: NOW },
      recordingFetch(422, JSON.stringify({ ok: false, error: "queue 'usage' not found" }))
    );
    assert.deepEqual(
      [rejected.ok, rejected.retryable, rejected.error],
      [false, true, "HTTP 422: queue 'usage' not found"]
    );
    const soft = await redDbTransport.send(
      { config, id: "ub_1", sinkId: "s", payload: {}, now: NOW },
      recordingFetch(200, JSON.stringify({ ok: false, error: "nope" }))
    );
    assert.equal(soft.ok, false, "HTTP 200 with ok:false is still a failure");
    const { calls, httpFetch } = recordingFetch();
    const big = await redDbTransport.send(
      {
        config,
        id: "ub_1",
        sinkId: "s",
        payload: { x: "y".repeat(REDDB_MAX_STATEMENT_BYTES) },
        now: NOW,
      },
      { httpFetch }
    );
    assert.deepEqual([big.ok, big.retryable], [false, false]);
    assert.equal(calls.length, 0);
  });

  test("validates the queue name and applies the egress guard to the URL", () => {
    const parse = (extra: Record<string, unknown>) =>
      redDbTransport.configSchema.safeParse({ ...config, ...extra });
    const trimmed = parse({ url: "https://reddb.example.test///" });
    assert.equal(trimmed.success && trimmed.data.url, "https://reddb.example.test");
    assert.equal(parse({ queue: "1bad" }).success, false);
    assert.equal(parse({ url: "ftp://reddb.example.test" }).success, false);
    assert.equal(parse({ url: "http://169.254.169.254" }).success, false);
    assert.equal(parse({ url: "http://127.0.0.1:5000" }).success, false);
  });
});

describe("registry", () => {
  test("one interface for every transport, with descriptors the form is rendered from", () => {
    assert.deepEqual(Object.keys(TRANSPORTS), ["webhook", "sqs", "kafka", "reddb"]);
    assert.equal(getTransport("carrier-pigeon"), null);
    for (const descriptor of describeTransports()) {
      const transport = TRANSPORTS[descriptor.type];
      assert.equal(typeof transport.send, "function");
      // Every declared secret has a password field in the form.
      for (const key of transport.secretFields) {
        const field = descriptor.fields.find((item) => item.key === key);
        assert.equal(field?.type, "password", `${descriptor.type}.${key}`);
        assert.equal(field?.secret, true);
      }
    }
  });
});
