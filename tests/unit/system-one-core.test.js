import { describe, expect, it, vi } from "vitest";
import {
  getSystemOneProviderOrder,
  handleSystemOneCore,
  normalizeSystemOneModel,
  validateSystemOneRequest,
} from "../../open-sse/handlers/systemOneCore.js";

const requestBody = {
  state: { ticket: "Production is down", tags: ["incident"] },
  model: "jev/jev-latest",
  questions: {
    urgency: {
      type: "noul",
      instructions: "Does this express urgency?",
    },
  },
};

describe("System One core", () => {
  it.each([
    [undefined, "jev-latest"],
    ["jev-latest", "jev-latest"],
    ["jev/jev-preview", "jev-preview"],
    ["typesafe/jev-1.13.0", "jev-1.13.0"],
    ["typesafe-ai/jev-next", "jev-next"],
    ["openrouter/typesafe/jev-1.13", "jev-1.13"],
  ])("normalizes model %s", (input, expected) => {
    expect(normalizeSystemOneModel(input)).toBe(expected);
  });

  it("prefers OpenRouter when its fully-qualified catalog model is requested", () => {
    expect(getSystemOneProviderOrder("openrouter/typesafe/jev-1.13")).toEqual([
      "openrouter",
      "typesafe-ai",
    ]);
  });

  it("rejects chat and non-JEV model identifiers", () => {
    expect(normalizeSystemOneModel("openai/gpt-5")).toBeNull();
    expect(validateSystemOneRequest({ ...requestBody, model: "gpt-5" })).toBe("Invalid JEV model");
  });

  it("forwards state/questions unchanged and uses the stored provider credential", async () => {
    const fetchImpl = vi.fn(async (_url, options) => Response.json({
      model: "jev-1.13.0",
      answers: { urgency: { type: "noul", noul: 0.92 } },
      usage: { input_tokens: 312, output_tokens: 48 },
    }, { headers: { "X-Request-Id": "ts_req_1" } }));

    const result = await handleSystemOneCore({
      body: requestBody,
      credentials: { apiKey: "stored-typesafe-secret" },
      fetchImpl,
    });

    expect(result.success).toBe(true);
    expect(result.usage).toEqual({ input_tokens: 312, output_tokens: 48 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(options.headers.Authorization).toBe("Bearer stored-typesafe-secret");
    expect(JSON.parse(options.body)).toEqual({ ...requestBody, model: "jev-latest" });
    expect((await result.response.json()).answers.urgency.noul).toBe(0.92);
  });

  it("routes OpenRouter credentials through the native Decisions API", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      model: "typesafe/jev-1.13",
      answers: { urgency: { type: "noul", noul: 0.88 } },
      usage: { input_tokens: 220, output_tokens: 0 },
    }));

    const result = await handleSystemOneCore({
      body: { ...requestBody, model: "jev-1.13.0" },
      providerId: "openrouter",
      credentials: { apiKey: "stored-openrouter-secret" },
      fetchImpl,
    });

    expect(result.success).toBe(true);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(options.headers.Authorization).toBe("Bearer stored-openrouter-secret");
    expect(JSON.parse(options.body)).toEqual({
      ...requestBody,
      model: "typesafe/jev-1.13",
    });
  });

  it.each([422, 429, 529])("preserves upstream %i bodies and Retry-After", async (status) => {
    const upstreamBody = { error: { message: `upstream-${status}` } };
    const result = await handleSystemOneCore({
      body: requestBody,
      credentials: { apiKey: "stored-secret" },
      fetchImpl: vi.fn(async () => Response.json(upstreamBody, {
        status,
        headers: { "Retry-After": "17", "Content-Encoding": "gzip" },
      })),
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(status);
    expect(result.response.status).toBe(status);
    expect(result.response.headers.get("retry-after")).toBe("17");
    expect(result.response.headers.get("content-encoding")).toBeNull();
    expect(await result.response.json()).toEqual(upstreamBody);
  });
});
