import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { buildQoderCnCosyHeaders } from "../../open-sse/services/qoderCnCosy.ts";

const chatUrl =
  "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1";

test("Qoder CN signs the exact UTF-8 bytes and strips /algo from its signature path", () => {
  const body = new TextEncoder().encode(JSON.stringify({ text: "ação 🚀" }));
  const machineId = randomUUID();
  const headers = buildQoderCnCosyHeaders(body, chatUrl, {
    userId: "cn-user",
    authToken: "dt-cn-token",
    machineId,
  });
  assert.equal(headers["Cosy-Bodylength"], String(body.byteLength));
  assert.equal(headers["Cosy-Bodyhash"], createHash("md5").update(body).digest("hex"));
  assert.equal(headers["Cosy-Sigpath"], "/api/v2/service/pro/sse/agent_chat_generation");
  assert.equal(headers["Cosy-Machineid"], machineId);
  assert.equal(headers["Cosy-Machinetoken"], machineId);
  assert.equal(headers["Cosy-User"], "cn-user");

  const match = headers.Authorization.match(/^Bearer COSY\.([A-Za-z0-9+/=]+)\.([a-f0-9]{32})$/);
  assert.ok(match);
  const payload = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  assert.equal(payload.version, "v1");
  assert.equal(payload.cosyVersion, "1.0.0");
  assert.equal(typeof payload.info, "string");
  const signedBytes = Buffer.concat([
    Buffer.from(`${match[1]}\n${headers["Cosy-Key"]}\n${headers["Cosy-Date"]}\n`, "utf8"),
    body,
    Buffer.from(`\n${headers["Cosy-Sigpath"]}`, "utf8"),
  ]);
  assert.equal(match[2], createHash("md5").update(signedBytes).digest("hex"));
  assert.doesNotMatch(headers.Authorization, /dt-cn-token/);
});

test("Qoder CN model-list GET signs an empty body", () => {
  const headers = buildQoderCnCosyHeaders(
    new Uint8Array(),
    "https://gateway.qoder.com.cn/algo/api/v2/model/list",
    { userId: "cn-user", authToken: "jt-cn-token" }
  );
  assert.equal(headers["Cosy-Bodylength"], "0");
  assert.equal(headers["Cosy-Sigpath"], "/api/v2/model/list");
});

test("Qoder CN never signs a PAT or a foreign/unrecognized endpoint", () => {
  assert.throws(
    () =>
      buildQoderCnCosyHeaders(new Uint8Array(), chatUrl, {
        userId: "cn-user",
        authToken: "pt-cn-raw",
      }),
    /Invalid|invalid/i
  );
  for (const url of [
    chatUrl.replace("gateway.qoder.com.cn", "api3.qoder.sh"),
    chatUrl.replace("gateway.qoder.com.cn", "evil.example"),
    "http://gateway.qoder.com.cn/algo/api/v2/model/list",
    "https://gateway.qoder.com.cn/algo/api/v2/other",
  ]) {
    assert.throws(
      () =>
        buildQoderCnCosyHeaders(new Uint8Array(), url, {
          userId: "cn-user",
          authToken: "dt-cn-token",
        }),
      /signing target is invalid/
    );
  }
});

test("Qoder CN refuses to sign an oversized body", () => {
  assert.throws(
    () =>
      buildQoderCnCosyHeaders(new Uint8Array(8 * 1024 * 1024 + 1), chatUrl, {
        userId: "cn-user",
        authToken: "dt-cn-token",
      }),
    /signing target is invalid/
  );
});
