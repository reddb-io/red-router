import assert from "node:assert/strict";
import test from "node:test";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";

test("RedRouter chat accepts the same host and endpoint URL forms as discovery", () => {
  const executor = new DefaultExecutor("red-router");
  for (const baseUrl of [
    "https://remote.example",
    "https://remote.example/v1",
    "https://remote.example/v1/models",
  ]) {
    assert.equal(
      executor.buildUrl("cc/claude-example", true, 0, {
        apiKey: "remote-only-key",
        providerSpecificData: { baseUrl },
      }),
      "https://remote.example/v1/chat/completions"
    );
  }
  assert.equal(
    executor.buildUrl("cc/claude-example", true),
    "http://127.0.0.1:25050/v1/chat/completions"
  );
});
