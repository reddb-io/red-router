import assert from "node:assert/strict";
import test from "node:test";

import { limitWebFetchContent } from "../../open-sse/handlers/webFetch.ts";
import { v1WebFetchSchema } from "../../src/shared/validation/schemas/apiV1.ts";

const response = {
  provider: "firecrawl",
  url: "https://example.com",
  content: "abcdef",
  links: [],
  metadata: { title: "Example", description: null },
  screenshot_url: null,
};

test("web fetch accepts the advertised max_characters parameter", () => {
  const parsed = v1WebFetchSchema.parse({ url: response.url, max_characters: 3 });
  assert.equal(parsed.max_characters, 3);
  assert.equal(v1WebFetchSchema.parse({ url: response.url }).max_characters, 0);
  assert.equal(
    v1WebFetchSchema.safeParse({ url: response.url, max_characters: -1 }).success,
    false
  );
});

test("web fetch truncates content consistently and signals it in metadata", () => {
  assert.deepEqual(limitWebFetchContent(response, 3), {
    ...response,
    content: "abc",
    metadata: { ...response.metadata, truncated: true },
  });
  assert.strictEqual(limitWebFetchContent(response, 0), response);
  assert.strictEqual(limitWebFetchContent(response, 6), response);
});
