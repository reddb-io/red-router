import assert from "node:assert/strict";
import test from "node:test";

import { decodeProtoFields } from "../../open-sse/services/usage/devinCli.ts";
import { getUsageForProvider } from "../../open-sse/services/usage.ts";
import { USAGE_FETCHER_PROVIDERS } from "../../open-sse/services/usage/fetcherProviders.ts";
import { USAGE_SUPPORTED_PROVIDERS } from "../../open-sse/services/usage/supportedProviders.ts";
import {
  buildWindsurfUserStatusRequest,
  getWindsurfUsage,
} from "../../open-sse/services/usage/windsurf.ts";

const encoder = new TextEncoder();

function varint(value: number): number[] {
  const bytes: number[] = [];
  do {
    const byte = value & 0x7f;
    value = Math.floor(value / 128);
    bytes.push(value ? byte | 0x80 : byte);
  } while (value);
  return bytes;
}

function bytesField(number: number, bytes: number[]): number[] {
  return [...varint((number << 3) | 2), ...varint(bytes.length), ...bytes];
}

function stringField(number: number, value: string): number[] {
  return bytesField(number, Array.from(encoder.encode(value)));
}

function quotaFixture(): Uint8Array {
  const plan = bytesField(1, stringField(2, "Pro"));
  const status = [
    ...plan,
    ...varint((14 << 3) | 0),
    ...varint(80),
    ...varint((15 << 3) | 0),
    ...varint(60),
  ];
  return Uint8Array.from(bytesField(1, bytesField(13, status)));
}

test("Windsurf usage request identifies the Windsurf IDE and embeds the API key", () => {
  const outer = decodeProtoFields(buildWindsurfUserStatusRequest("sk-ws-test"));
  const metadata = outer?.find((field) => field.field === 1)?.bytes;
  assert.ok(metadata);
  const fields = decodeProtoFields(metadata);
  assert.ok(fields);
  assert.equal(
    new TextDecoder().decode(fields.find((field) => field.field === 1)?.bytes),
    "windsurf"
  );
  assert.equal(
    new TextDecoder().decode(fields.find((field) => field.field === 3)?.bytes),
    "sk-ws-test"
  );
});

test("Windsurf quota fetcher is registered and dispatches the retained API key", async () => {
  assert.ok(USAGE_FETCHER_PROVIDERS.includes("windsurf"));
  assert.ok(USAGE_SUPPORTED_PROVIDERS.includes("windsurf"));
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(quotaFixture());
  };
  try {
    const result = (await getUsageForProvider({
      provider: "windsurf",
      accessToken: "sk-ws-test",
    })) as { plan?: string; quotas?: Record<string, { remaining: number }> };
    assert.equal(result.plan, "Pro");
    assert.equal(result.quotas?.daily.remaining, 80);
    assert.equal(result.quotas?.weekly.remaining, 60);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus"
    );
    assert.equal(calls[0].init.method, "POST");
    assert.equal(
      (calls[0].init.headers as Record<string, string>).Authorization,
      "Basic sk-ws-test-sk-ws-test"
    );
    assert.ok(calls[0].init.body);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Windsurf quota fails closed without exposing credentials or inventing a balance", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("bad token sk-ws-private", { status: 401 });
  };
  try {
    const missing = await getWindsurfUsage("");
    assert.ok("message" in missing);
    assert.equal(calls, 0);

    const rejected = await getWindsurfUsage("sk-ws-private");
    assert.equal(calls, 1);
    assert.ok("message" in rejected);
    assert.doesNotMatch(rejected.message ?? "", /sk-ws-private/);
    assert.equal("quotas" in rejected, false);

    globalThis.fetch = async () => new Response(Uint8Array.from([0x0a, 0xff]));
    const malformed = await getWindsurfUsage("sk-ws-private");
    assert.ok("message" in malformed);
    assert.equal("quotas" in malformed, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
