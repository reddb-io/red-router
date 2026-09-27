import assert from "node:assert/strict";
import test from "node:test";

import { rewriteQoderCnAttachments } from "../../open-sse/services/qoderCnAttachments.ts";

const credentials = { userId: "cn-user", authToken: "dt-cn-token" };
const inlineImage = `data:image/png;base64,${Buffer.from("tiny image").toString("base64")}`;

test("Qoder CN uploads inline images with a signed non-replayable multipart request", async () => {
  let uploads = 0;
  const rewritten = await rewriteQoderCnAttachments(
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect this" },
            { type: "image_url", image_url: { url: inlineImage } },
            { type: "image_url", image_url: { url: inlineImage } },
          ],
        },
      ],
    },
    credentials,
    async (url, init) => {
      uploads++;
      assert.equal(new URL(url).host, "gateway.qoder.com.cn");
      assert.equal(new URL(url).pathname, "/algo/api/v2/image/upload");
      assert.equal(init.method, "PUT");
      assert.ok(init.body instanceof ReadableStream);
      assert.equal((init as RequestInit & { duplex?: string }).duplex, "half");
      const body = Buffer.from(await new Response(init.body).arrayBuffer());
      const headers = init.headers as Record<string, string>;
      assert.match(headers.Authorization, /^Bearer COSY\./);
      assert.equal(headers["Cosy-Bodylength"], String(body.byteLength));
      assert.match(body.toString("utf8"), /name="file"; filename="image.png"/);
      return Response.json({ result: { imageUrls: ["https://oss.qoder.com.cn/image-1"] } });
    }
  );
  assert.equal(uploads, 1);
  const parts = (rewritten as { messages: Array<{ content: unknown[] }> }).messages[0].content;
  assert.deepEqual(parts.slice(1), [
    { type: "image_url", image_url: { url: "https://oss.qoder.com.cn/image-1" } },
    { type: "image_url", image_url: { url: "https://oss.qoder.com.cn/image-1" } },
  ]);
});

test("Qoder CN rejects unsupported documents and invalid upload responses without omitting them", async () => {
  await assert.rejects(
    rewriteQoderCnAttachments(
      { messages: [{ role: "user", content: [{ type: "document", source: {} }] }] },
      credentials,
      async () => {
        throw new Error("fetch must not run");
      }
    ),
    /unsupported/
  );
  await assert.rejects(
    rewriteQoderCnAttachments(
      { messages: [{ role: "user", content: [{ type: "image_url", image_url: inlineImage }] }] },
      credentials,
      async () => Response.json({ imageUrl: "http://unsafe.example/image.png" })
    ),
    /image URL is invalid/
  );
});
