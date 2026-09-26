import assert from "node:assert/strict";
import test from "node:test";

import { createTempDataDir } from "../_setup/tempDataDir.ts";

const previousRequireApiKey = process.env.REQUIRE_API_KEY;
const previousApiKeySecret = process.env.API_KEY_SECRET;
process.env.REQUIRE_API_KEY = "false";
process.env.API_KEY_SECRET = "video-async-route-test-secret";
const { cleanup } = createTempDataDir("omniroute-video-async-");
const originalFetch = globalThis.fetch;

const providers = await import("../../src/lib/db/providers.ts");
const jobs = await import("../../src/lib/db/videoJobs.ts");
const asyncVideo = await import("../../src/app/api/v1/_shared/xaiAsyncVideo.ts");

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});
test.after(async () => {
  if (previousRequireApiKey === undefined) delete process.env.REQUIRE_API_KEY;
  else process.env.REQUIRE_API_KEY = previousRequireApiKey;
  if (previousApiKeySecret === undefined) delete process.env.API_KEY_SECRET;
  else process.env.API_KEY_SECRET = previousApiKeySecret;
  await cleanup();
});

function createRequest(key: string): Request {
  return new Request("http://localhost/v1/videos/edits", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ model: "xai/grok-imagine-video", prompt: "Make it blue" }),
  });
}

test("async video submission is durable, idempotent, and polls its creating account", async () => {
  const connection = await providers.createProviderConnection({
    provider: "xai",
    authType: "apikey",
    apiKey: "video-async-test-key",
  });
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method || "GET" });
    if (init?.method === "POST") {
      assert.equal(
        (init.headers as Record<string, string>).Authorization,
        "Bearer video-async-test-key"
      );
      return Response.json({
        request_id:
          calls.filter((call) => call.method === "POST").length === 1 ? "xai-job-1" : "xai-job-2",
        status: "pending",
      });
    }
    return Response.json({
      request_id: "xai-job-1",
      status: "done",
      video: { url: "https://videos.x.ai/result.mp4" },
    });
  }) as typeof fetch;

  const created = await asyncVideo.createXaiAsyncVideo(createRequest("video-idem-1"), "edits");
  assert.equal(created.status, 202);
  const body = (await created.json()) as { request_id: string; job_id: string };
  assert.equal(body.request_id, "xai-job-1");
  assert.notEqual(body.job_id, body.request_id, "local job_id and xAI request_id are distinct");
  assert.equal(
    jobs.getVideoJob(body.job_id, "anonymous-dashboard-or-open-api")?.connectionId,
    connection.id
  );
  assert.equal(
    jobs.getVideoJob(body.job_id, "anonymous-dashboard-or-open-api")?.upstreamRequestId,
    body.request_id
  );
  assert.equal(created.headers.get("x-9router-connection-id"), connection.id);
  assert.equal(calls.length, 1);

  const replay = await asyncVideo.createXaiAsyncVideo(createRequest("video-idem-1"), "edits");
  assert.equal(replay.status, 202);
  assert.equal(((await replay.json()) as { request_id: string }).request_id, body.request_id);
  assert.equal(calls.length, 1, "replay must not submit another billable job");

  const polled = await asyncVideo.getXaiAsyncVideo(
    new Request(`http://localhost/v1/videos/${body.request_id}`),
    body.request_id
  );
  assert.equal(polled.status, 200);
  const result = (await polled.json()) as {
    request_id: string;
    status: string;
    video: { url: string };
  };
  assert.equal(result.request_id, body.request_id);
  assert.equal(result.status, "done");
  assert.equal(result.video.url, "https://videos.x.ai/result.mp4");
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://api.x.ai/v1/videos/edits", "https://api.x.ai/v1/videos/xai-job-1"]
  );

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), "https://api.x.ai/v1/videos/extensions");
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer video-async-test-key"
    );
    assert.equal(JSON.parse(String(init?.body)).video_id, "xai-job-1");
    return Response.json({ request_id: "xai-job-2", status: "pending" });
  }) as typeof fetch;
  const extension = await asyncVideo.createXaiAsyncVideo(
    new Request("http://localhost/v1/videos/extensions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "extend-idem-1" },
      body: JSON.stringify({ model: "xai/grok-imagine-video", video_id: body.job_id }),
    }),
    "extensions"
  );
  assert.equal(extension.status, 202);
  assert.equal(((await extension.json()) as { request_id: string }).request_id, "xai-job-2");
});

test("ambiguous network failure is persisted and never resubmitted", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("socket closed after send");
  }) as typeof fetch;

  const first = await asyncVideo.createXaiAsyncVideo(
    createRequest("video-idem-uncertain"),
    "edits"
  );
  assert.equal(first.status, 502);
  const body = (await first.json()) as { request_id: string; status: string };
  assert.equal(body.status, "uncertain");
  assert.equal(
    jobs.getVideoJob(body.request_id, "anonymous-dashboard-or-open-api")?.state,
    "uncertain"
  );

  const replay = await asyncVideo.createXaiAsyncVideo(
    createRequest("video-idem-uncertain"),
    "edits"
  );
  assert.equal(replay.status, 409);
  assert.equal(calls, 1);
});

test("a duplicate arriving during the first billable POST never sends a second POST", async () => {
  await providers.createProviderConnection({
    provider: "xai",
    authType: "apikey",
    apiKey: "video-inflight-test-key",
  });
  let signalFirstPost: (() => void) | undefined;
  const firstPostStarted = new Promise<void>((resolve) => {
    signalFirstPost = resolve;
  });
  let completeFirstPost: ((response: Response) => void) | undefined;
  const pendingUpstream = new Promise<Response>((resolve) => {
    completeFirstPost = resolve;
  });
  let postCount = 0;
  globalThis.fetch = (async () => {
    postCount++;
    signalFirstPost?.();
    return pendingUpstream;
  }) as typeof fetch;

  const firstPromise = asyncVideo.createXaiAsyncVideo(
    createRequest("video-inflight-duplicate"),
    "edits"
  );
  await firstPostStarted;
  try {
    const duplicate = await asyncVideo.createXaiAsyncVideo(
      createRequest("video-inflight-duplicate"),
      "edits"
    );
    assert.equal(duplicate.status, 409);
    assert.equal(postCount, 1);
  } finally {
    completeFirstPost?.(Response.json({ request_id: "xai-inflight-job" }));
  }
  const first = await firstPromise;
  assert.equal(first.status, 202);
  assert.equal(((await first.json()) as { request_id: string }).request_id, "xai-inflight-job");

  const replay = await asyncVideo.createXaiAsyncVideo(
    createRequest("video-inflight-duplicate"),
    "edits"
  );
  assert.equal(replay.status, 202);
  assert.equal(postCount, 1);
});

test("extension cannot override the source video's connection", async () => {
  const source = jobs.reserveVideoJob({
    owner: "anonymous-dashboard-or-open-api",
    idempotencyKey: "source-cross-account",
    requestHash: "c".repeat(64),
    action: "generations",
    provider: "xai",
    model: "grok-imagine-video",
    connectionId: "source-connection",
  });
  assert.equal(source.kind, "created");
  assert.equal(jobs.markVideoJobSubmitted(source.job.id, "cross-account-upstream"), true);
  globalThis.fetch = (async () => {
    throw new Error("cross-account extension reached upstream");
  }) as typeof fetch;
  const response = await asyncVideo.createXaiAsyncVideo(
    new Request("http://localhost/v1/videos/extensions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-connection-id": "other-connection",
      },
      body: JSON.stringify({ video_id: source.job.id }),
    }),
    "extensions"
  );
  assert.equal(response.status, 409);
});

test("edit route forwards multipart bytes and boundary without re-encoding", async () => {
  const edits = await import("../../src/app/api/v1/videos/edits/route.ts");
  const boundary = "----xaiAsyncBoundary";
  const raw = `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nextend the shot\r\n--${boundary}--\r\n`;
  let forwarded: { body: string; contentType: string; url: string } | null = null;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    forwarded = {
      url: String(url),
      body: Buffer.from(init?.body as Uint8Array).toString(),
      contentType: (init?.headers as Record<string, string>)["Content-Type"],
    };
    return Response.json({ request_id: "xai-multipart-job" });
  }) as typeof fetch;

  const response = await edits.POST(
    new Request("http://localhost/v1/videos/edits", {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "idempotency-key": "video-idem-multipart",
      },
      body: raw,
    })
  );

  assert.equal(response.status, 202);
  assert.deepEqual(forwarded, {
    url: "https://api.x.ai/v1/videos/edits",
    body: raw,
    contentType: `multipart/form-data; boundary=${boundary}`,
  });
});
