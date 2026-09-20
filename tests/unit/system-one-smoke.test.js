import { describe, expect, it, vi } from "vitest";
import {
  buildSystemOneSmokeCandidates,
  runSystemOneSmoke,
} from "../../scripts/smoke-system-one.mjs";

const payload = {
  model: "jev-1.13-free",
  answers: { readiness: { type: "noul", noul: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 2 },
};

describe("System One release smoke provider selection", () => {
  it("uses public OpenCode Zen without requiring a TypeSafe credential", () => {
    expect(buildSystemOneSmokeCandidates({})).toEqual([
      expect.objectContaining({
        id: "opencode-zen",
        endpoint: "https://opencode.ai/zen/v1/systemone",
        model: "jev-1.13-free",
        token: "public",
      }),
    ]);
  });

  it("tries configured providers before the public Zen fallback", () => {
    const candidates = buildSystemOneSmokeCandidates({
      TYPESAFE_AI_API_KEY: "typesafe-secret",
      OPENROUTER_API_KEY: "openrouter-secret",
      SYSTEM_ONE_SMOKE_BASE_URL: "https://jev.example/v1",
      SYSTEM_ONE_SMOKE_MODEL: "vendor/jev",
      SYSTEM_ONE_SMOKE_API_KEY: "generic-secret",
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "custom",
      "typesafe",
      "openrouter",
      "opencode-zen",
    ]);

    expect(candidates[2]).toEqual(expect.objectContaining({
      endpoint: "https://openrouter.ai/api/alpha/decisions",
      model: "typesafe/jev-1.13",
      token: "openrouter-secret",
    }));
  });

  it("falls through a failed provider and accepts a valid Noul response", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { message: "unavailable" } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json(payload));

    const result = await runSystemOneSmoke({
      env: { TYPESAFE_AI_API_KEY: "typesafe-secret" },
      fetchImpl,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result.provider).toBe("opencode-zen");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls through a failed OpenRouter Decisions request to public Zen", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { message: "unauthorized" } }, { status: 401 }))
      .mockResolvedValueOnce(Response.json(payload));

    const result = await runSystemOneSmoke({
      env: { OPENROUTER_API_KEY: "expired-openrouter-secret" },
      fetchImpl,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result.provider).toBe("opencode-zen");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses the Cloudflare AI Gateway envelope when configured", async () => {
    const fetchImpl = vi.fn(async () => Response.json(payload));
    await runSystemOneSmoke({
      env: {
        CLOUDFLARE_API_TOKEN: "cf-secret",
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_GATEWAY_ID: "gateway",
      },
      fetchImpl,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/account/ai/run");
    expect(options.redirect).toBe("error");
    expect(options.headers["cf-aig-gateway-id"]).toBe("gateway");
    expect(JSON.parse(options.body)).toEqual({
      model: "typesafe/jev",
      input: expect.objectContaining({ state: "RedRouter release validation" }),
    });
  });
});
