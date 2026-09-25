import { beforeEach, describe, expect, it, vi } from "vitest";
import { signV4, sendSqs, regionFromQueueUrl } from "../../src/lib/usageSinks/sqs.js";
import { sendKafka, resetKafkaProducers } from "../../src/lib/usageSinks/kafka.js";
import { sendReddbQueue, queuePushStatement } from "../../src/lib/usageSinks/reddb.js";
import { TRANSPORTS } from "../../src/lib/usageSinks/transports.js";
import { parseSinkInput, publicSink } from "../../src/lib/usageSinks/input.js";

const okFetch = (status = 200, body = "{}") => vi.fn(async () => new Response(body, { status }));
const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };

describe("SQS transport", () => {
  it("signs like botocore (SigV4 reference output)", () => {
    const body = String.raw`{"QueueUrl": "https://sqs.us-east-1.amazonaws.com/123456789012/usage", "MessageBody": "{\"a\":1}"}`;
    const headers = signV4({
      method: "POST", url: "https://sqs.us-east-1.amazonaws.com/", body, region: "us-east-1", service: "sqs", ...creds, sessionToken: "tok123",
      headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "AmazonSQS.SendMessage" }, date: new Date("2026-09-25T13:50:03Z"),
    });
    expect(headers.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260925/us-east-1/sqs/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=17cb84675fd0fe8c749f509ab06d5982907f5643cf05769dd8861c774d46ef77");
    expect(headers["x-amz-security-token"]).toBe("tok123");
  });

  it("reads the region from an AWS queue URL", () => {
    expect(regionFromQueueUrl("https://sqs.sa-east-1.amazonaws.com/1/q")).toBe("sa-east-1");
    expect(regionFromQueueUrl("http://localhost:4566/000000000000/q")).toBeNull();
  });

  it("dedupes and orders on a FIFO queue with the delivery and sink ids", async () => {
    const fetchImpl = okFetch();
    const result = await sendSqs({ config: { queueUrl: "https://sqs.us-east-1.amazonaws.com/1/usage.fifo", ...creds }, id: "ub_1", payload: { a: 1 }, sinkId: "sink1", fetchImpl });
    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://sqs.us-east-1.amazonaws.com/");
    expect(init.headers["x-amz-target"]).toBe("AmazonSQS.SendMessage");
    expect(JSON.parse(init.body)).toMatchObject({ MessageBody: '{"a":1}', MessageGroupId: "sink1", MessageDeduplicationId: "ub_1" });
  });

  it("reports the SQS error type and keeps retrying", async () => {
    const fetchImpl = okFetch(400, JSON.stringify({ __type: "com.amazonaws.sqs#QueueDoesNotExist", message: "The specified queue does not exist." }));
    const result = await sendSqs({ config: { queueUrl: "https://sqs.us-east-1.amazonaws.com/1/usage", ...creds }, id: "ub_1", payload: {}, fetchImpl });
    expect(result).toMatchObject({ ok: false, retryable: true, status: 400, error: "HTTP 400: QueueDoesNotExist: The specified queue does not exist." });
  });
});

describe("Kafka transport", () => {
  beforeEach(() => resetKafkaProducers());

  const fakeKafka = ({ failSend = false } = {}) => {
    const producer = {
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      send: vi.fn(async () => {
        if (failSend) throw new Error("broker down");
        return [{ partition: 2, baseOffset: "41" }];
      }),
    };
    return { producer, factory: vi.fn(async () => ({ producer: () => producer })) };
  };
  const config = { brokers: ["k1:9092"], topic: "usage" };

  it("produces keyed by sink with the delivery id header, reusing the connection", async () => {
    const { producer, factory } = fakeKafka();
    const r = await sendKafka({ config, id: "ub_1", payload: { a: 1 }, sinkId: "sink1", kafkaFactory: factory });
    await sendKafka({ config, id: "ub_2", payload: {}, sinkId: "sink1", kafkaFactory: factory });
    expect(r).toMatchObject({ ok: true, statusText: "partition 2, offset 41", url: "kafka://k1:9092/usage" });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(producer.send.mock.calls[0][0]).toEqual({
      topic: "usage",
      messages: [{ key: "sink1", value: '{"a":1}', headers: { "redrouter-delivery-id": "ub_1", "content-type": "application/json" } }],
    });
  });

  it("drops the producer after an error so the next attempt reconnects", async () => {
    const { producer, factory } = fakeKafka({ failSend: true });
    const r = await sendKafka({ config, id: "ub_1", payload: {}, kafkaFactory: factory });
    expect(r).toMatchObject({ ok: false, retryable: true, error: "broker down" });
    expect(producer.disconnect).toHaveBeenCalled();
    await sendKafka({ config, id: "ub_1", payload: {}, kafkaFactory: factory });
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe("RedDB queue transport", () => {
  it("builds a QUEUE PUSH with the delivery id as DEDUP key, quotes escaped", () => {
    expect(queuePushStatement("usage", { a: "it's" }, "ub_'1")).toBe(`QUEUE PUSH usage {"a":"it's"} DEDUP 'ub_''1'`);
  });

  it("posts to /query with the token and tenant", async () => {
    const fetchImpl = okFetch(200, JSON.stringify({ ok: true, statement: "queue_push" }));
    const r = await sendReddbQueue({ config: { url: "http://db:5000/", queue: "usage", token: "rdb_k_x", tenant: "t1" }, id: "ub_1", payload: { a: 1 }, fetchImpl });
    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://db:5000/query");
    expect(init.headers).toMatchObject({ authorization: "Bearer rdb_k_x", "x-reddb-tenant": "t1" });
    expect(JSON.parse(init.body)).toEqual({ query: `QUEUE PUSH usage {"a":1} DEDUP 'ub_1'` });
  });

  it("fails on ok:false and on statements over RedDB's 1 MiB limit", async () => {
    const r = await sendReddbQueue({ config: { url: "http://db:5000", queue: "usage" }, id: "ub_1", payload: {}, fetchImpl: okFetch(422, JSON.stringify({ ok: false, error: "queue 'usage' not found" })) });
    expect(r).toMatchObject({ ok: false, retryable: true, error: "HTTP 422: queue 'usage' not found" });
    const big = await sendReddbQueue({ config: { url: "http://db:5000", queue: "usage" }, id: "ub_1", payload: { x: "y".repeat(1024 * 1024) }, fetchImpl: okFetch() });
    expect(big).toMatchObject({ ok: false, retryable: false });
  });
});

describe("sink config per transport", () => {
  const input = (type, config) => parseSinkInput({ name: "S", type, mode: "instant", config });

  it("validates each transport's config", () => {
    expect(input("sqs", { queueUrl: "http://localhost:4566/0/q", ...creds }).error).toMatch(/Region is required/);
    expect(input("kafka", { brokers: "nohost", topic: "t" }).error).toMatch(/host:port/);
    expect(input("kafka", { brokers: "k:9092", topic: "t", sasl: { mechanism: "plain", username: "u" } }).error).toMatch(/SASL needs/);
    expect(input("reddb", { url: "http://db:5000", queue: "1bad" }).error).toMatch(/queue name/);
    expect(input("carrier-pigeon", {}).error).toMatch(/Type must be one of/);
    expect(input("kafka", { brokers: "k1:9092, k2:9093", topic: "usage" }).value.config).toEqual({ brokers: ["k1:9092", "k2:9093"], topic: "usage", clientId: "red-router", ssl: false, sasl: null });
  });

  it("keeps stored secrets when an update leaves them empty", () => {
    const stored = { type: "sqs", mode: "instant", config: { queueUrl: "https://sqs.us-east-1.amazonaws.com/1/q", region: "us-east-1", ...creds, sessionToken: "tok" } };
    const { value } = parseSinkInput({ config: { queueUrl: stored.config.queueUrl, accessKeyId: "AKID2", secretAccessKey: "" } }, stored);
    expect(value.config).toMatchObject({ accessKeyId: "AKID2", secretAccessKey: creds.secretAccessKey, sessionToken: "tok" });
    const cleared = parseSinkInput({ config: { queueUrl: stored.config.queueUrl, accessKeyId: "AKID2", sessionToken: "-" } }, stored);
    expect(cleared.value.config.sessionToken).toBe("");
  });

  it("never returns a secret from the API", () => {
    const sinks = [
      { type: "webhook", config: { url: "https://h", secret: "whsec_SECRET1" } },
      { type: "sqs", config: { queueUrl: "https://sqs.us-east-1.amazonaws.com/1/q", region: "us-east-1", accessKeyId: "AKID", secretAccessKey: "SECRET2", sessionToken: "SECRET3" } },
      { type: "kafka", config: { brokers: ["k:9092"], topic: "t", sasl: { mechanism: "plain", username: "u", password: "SECRET4" } } },
      { type: "reddb", config: { url: "http://db:5000", queue: "q", token: "SECRET5" } },
    ];
    for (const sink of sinks) {
      const out = JSON.stringify(publicSink({ id: "s", ...sink }));
      expect(out, sink.type).not.toMatch(/SECRET\d(?!…)/);
      expect(publicSink({ id: "s", ...sink }).summary, sink.type).toBe(TRANSPORTS[sink.type].summary(sink.config));
    }
  });
});
