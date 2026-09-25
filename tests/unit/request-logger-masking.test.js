// ENABLE_REQUEST_LOGS writes every request to logs/ in plain text; credentials must not land there.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const SECRET = "sk-ant-oat01-THIS-IS-A-VERY-SECRET-TOKEN-1234567890";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("maskSensitiveHeaders", () => {
  it("redacts credential headers and keeps the rest", async () => {
    const { maskSensitiveHeaders } = await import("../../open-sse/utils/requestLogger.js");
    const masked = maskSensitiveHeaders({
      Authorization: `Bearer ${SECRET}`,
      "x-api-key": SECRET,
      "x-goog-api-key": SECRET,
      Cookie: `session=${SECRET}`,
      "anthropic-beta": "oauth-2025-04-20,context-management-2025-06-27",
      "content-type": "application/json",
    });
    expect(JSON.stringify(masked)).not.toContain(SECRET);
    expect(masked.Authorization).toBe(`Bearer <redacted len=${SECRET.length + 7}>`);
    expect(masked["x-api-key"]).toBe(`<redacted len=${SECRET.length}>`);
    expect(masked["anthropic-beta"]).toBe("oauth-2025-04-20,context-management-2025-06-27");
    expect(masked["content-type"]).toBe("application/json");
  });

  it("accepts a fetch Headers object", async () => {
    const { maskSensitiveHeaders } = await import("../../open-sse/utils/requestLogger.js");
    const masked = maskSensitiveHeaders(new Headers({ authorization: `Bearer ${SECRET}`, "x-request-id": "r1" }));
    expect(masked).toEqual({ authorization: `Bearer <redacted len=${SECRET.length + 7}>`, "x-request-id": "r1" });
  });
});

describe("createRequestLogger", () => {
  it("never writes a credential to the log files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-logs-"));
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    vi.stubEnv("ENABLE_REQUEST_LOGS", "true");
    const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.js");

    const logger = await createRequestLogger("claude", "claude", "claude-code/claude-opus-5-5");
    const body = { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] };
    logger.logClientRawRequest("/v1/messages", body, { authorization: `Bearer ${SECRET}` });
    logger.logRawRequest(body, { "x-api-key": SECRET });
    logger.logTargetRequest("https://api.anthropic.com/v1/messages", { authorization: `Bearer ${SECRET}` }, body);
    logger.logProviderResponse(200, "OK", new Headers({ "set-cookie": `sid=${SECRET}` }), { ok: true });

    const files = fs.readdirSync(logger.sessionPath);
    expect(files).toEqual(
      expect.arrayContaining(["1_req_client.json", "2_req_source.json", "4_req_target.json", "5_res_provider.json"]),
    );
    for (const file of files) {
      expect(fs.readFileSync(path.join(logger.sessionPath, file), "utf8")).not.toContain(SECRET);
    }
    const client = JSON.parse(fs.readFileSync(path.join(logger.sessionPath, "1_req_client.json"), "utf8"));
    expect(client.body).toEqual(body);
    expect(client.endpoint).toBe("/v1/messages");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
