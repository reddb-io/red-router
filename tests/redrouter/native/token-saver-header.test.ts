import assert from "node:assert/strict";
import { test } from "node:test";

const { resolveCompressionHeader } = await import("../../../open-sse/handlers/chatCore/headers.ts");

test("x-red-router-token-saver off keeps the prompt intact, on asks for the panel default", () => {
  assert.equal(resolveCompressionHeader({ "x-red-router-token-saver": "off" }), "off");
  assert.equal(resolveCompressionHeader({ "X-Red-Router-Token-Saver": " ON " }), "default");
  assert.equal(resolveCompressionHeader({ "x-red-router-token-saver": "maybe" }), null);
  assert.equal(resolveCompressionHeader({}), null);
});

test("an explicit OmniRoute compression header wins over the RedRouter one", () => {
  assert.equal(
    resolveCompressionHeader({
      "x-omniroute-compression": "engine:caveman",
      "x-red-router-token-saver": "off",
    }),
    "engine:caveman"
  );
});
