// The deterministic test environment (setup/deterministic.js) must hold, or every
// other result depends on the machine the suite runs on.
import { describe, it, expect } from "vitest";
import http from "node:http";
import os from "node:os";

describe("deterministic test environment", () => {
  it("blocks outbound network immediately", async () => {
    const started = Date.now();
    const error = await fetch("https://example.com/").then(() => null, (e) => e);
    expect(error?.cause?.code ?? error?.code).toBe("ERR_TEST_NETWORK_BLOCKED");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("still allows loopback servers", async () => {
    const server = http.createServer((_, res) => res.end("ok"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const body = await fetch(`http://127.0.0.1:${server.address().port}/`).then((r) => r.text());
      expect(body).toBe("ok");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("sandboxes HOME and DATA_DIR per file and runs in UTC", () => {
    expect(os.homedir()).toContain("rr-test-");
    expect(process.env.DATA_DIR.startsWith(os.homedir())).toBe(true);
    expect(new Date(0).getTimezoneOffset()).toBe(0);
  });
});
