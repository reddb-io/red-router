import { randomUUID } from "node:crypto";

import { PROVIDERS } from "../config/constants.ts";
import {
  QoderCnAttachmentInputError,
  rewriteQoderCnAttachments,
} from "../services/qoderCnAttachments.ts";
import { buildQoderCnCosyHeaders } from "../services/qoderCnCosy.ts";
import { encodeQoderCnBody } from "../services/qoderCnEncoding.ts";
import { getQoderCnModelConfig } from "../services/qoderCnModels.ts";
import { resolveQoderCnPat } from "../services/qoderCnPat.ts";
import { buildQoderCnRequest } from "../services/qoderCnRequest.ts";
import { wrapQoderCnSse } from "../services/qoderCnSse.ts";
import { buildErrorBody } from "../utils/error.ts";
import { BaseExecutor, type ExecuteInput } from "./base.ts";

const CHAT_URL =
  "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;
type ToolCall = { id?: string; type: string; function: { name: string; arguments: string } };

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify(buildErrorBody(status, message)), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Collect the already-sanitized OpenAI SSE stream for non-streaming callers. */
async function collectCompletion(response: Response, model: string): Promise<Response> {
  if (!response.ok) return response;
  const raw = await response.text();
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let id = `chatcmpl-qoder-cn-${randomUUID()}`;
  let created = Math.floor(Date.now() / 1000);
  let usage: JsonRecord | undefined;
  let done = false;
  const tools = new Map<number, ToolCall>();

  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      break;
    }
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return errorResponse(502, "Qoder CN returned invalid completion data");
    }
    const chunk = record(value);
    if (!chunk) return errorResponse(502, "Qoder CN returned invalid completion data");
    if (chunk.error) {
      const error = record(chunk.error);
      const status = typeof error?.status === "number" ? error.status : 502;
      return errorResponse(
        status >= 400 && status <= 599 ? status : 502,
        "Qoder CN streaming completion failed"
      );
    }
    if (typeof chunk.id === "string") id = chunk.id;
    if (typeof chunk.created === "number") created = chunk.created;
    if (record(chunk.usage)) usage = record(chunk.usage) || undefined;
    const choice = Array.isArray(chunk.choices) ? record(chunk.choices[0]) : null;
    const delta = record(choice?.delta);
    if (typeof delta?.content === "string") content += delta.content;
    if (typeof delta?.reasoning_content === "string") reasoning += delta.reasoning_content;
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    if (Array.isArray(delta?.tool_calls)) {
      for (const rawTool of delta.tool_calls) {
        const tool = record(rawTool);
        const index = tool?.index;
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 127) {
          return errorResponse(502, "Qoder CN returned an invalid tool call");
        }
        const key = index;
        const previous: ToolCall = tools.get(key) || {
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (typeof tool?.id === "string") previous.id = tool.id;
        const fn = record(tool?.function);
        if (typeof fn?.name === "string") previous.function.name += fn.name;
        if (typeof fn?.arguments === "string") previous.function.arguments += fn.arguments;
        tools.set(key, previous);
      }
    }
  }
  if (!done || !finishReason)
    return errorResponse(502, "Qoder CN completion ended without a finish");
  const message: JsonRecord = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (tools.size) {
    const calls = [...tools.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, tool]) => tool);
    if (calls.some((tool) => !tool.id || !tool.function.name)) {
      return errorResponse(502, "Qoder CN returned an incomplete tool call");
    }
    message.tool_calls = calls;
  }
  return new Response(
    JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

/** Candidate-only CN transport. Registration waits for upload, quota and validation parity. */
export class QoderCnExecutor extends BaseExecutor {
  constructor(private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)) {
    super("qoder-cn", PROVIDERS["qoder-cn"]);
  }

  async execute({ model, body, stream, credentials, signal }: ExecuteInput) {
    const result = (
      response: Response,
      headers: Record<string, string> = {},
      transformedBody?: unknown
    ) => ({
      response,
      url: CHAT_URL,
      headers,
      transformedBody,
    });
    const token = (credentials.apiKey || credentials.accessToken || "").trim();
    if (!token) return result(errorResponse(401, "Qoder CN credentials are required"));
    const modelKey = model.startsWith("qoder-cn/") ? model.slice("qoder-cn/".length) : model;
    if (!modelKey || modelKey.includes("/") || modelKey.length > 128) {
      return result(errorResponse(400, "Qoder CN model is invalid"));
    }

    let userId = credentials.providerSpecificData?.userId;
    let authToken = token;
    if (token.startsWith("pt-")) {
      try {
        const exchanged = await resolveQoderCnPat(token, {
          fetchImpl: this.fetchImpl,
          signal: signal || undefined,
        });
        authToken = exchanged.accessToken;
        userId = exchanged.userId;
      } catch {
        return result(errorResponse(401, "Qoder CN PAT exchange failed"));
      }
    }
    if (typeof userId !== "string" || !userId) {
      return result(errorResponse(401, "Qoder CN account requires re-login"));
    }

    let config: JsonRecord;
    try {
      config = await getQoderCnModelConfig(
        {
          token: authToken,
          userId,
          machineId:
            typeof credentials.providerSpecificData?.machineId === "string"
              ? credentials.providerSpecificData.machineId
              : undefined,
          email: credentials.email || undefined,
        },
        modelKey,
        { fetchImpl: this.fetchImpl, signal: signal || undefined }
      );
    } catch {
      return result(errorResponse(502, "Qoder CN model catalog is unavailable"));
    }

    let payload: JsonRecord;
    let encoded: Uint8Array;
    let headers: Record<string, string>;
    const cosyCredential = {
      authToken,
      userId,
      machineId:
        typeof credentials.providerSpecificData?.machineId === "string"
          ? credentials.providerSpecificData.machineId
          : undefined,
      email: credentials.email || undefined,
    };
    let preparedBody: unknown;
    try {
      preparedBody = await rewriteQoderCnAttachments(
        body,
        cosyCredential,
        this.fetchImpl,
        signal || undefined
      );
    } catch (error) {
      return result(
        errorResponse(
          error instanceof QoderCnAttachmentInputError ? 400 : 502,
          "Qoder CN attachment preparation failed"
        )
      );
    }
    try {
      const request = buildQoderCnRequest(modelKey, preparedBody, config, userId);
      payload = request.payload;
      encoded = encodeQoderCnBody(request.plaintext);
      headers = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        "Accept-Encoding": "identity",
        "X-Model-Key": modelKey,
        "X-Model-Source": typeof config.source === "string" ? config.source : "system",
        ...buildQoderCnCosyHeaders(encoded, CHAT_URL, cosyCredential),
      };
    } catch {
      return result(errorResponse(400, "Qoder CN chat request is unsupported or invalid"));
    }

    let upstream: Response;
    try {
      const timeout = AbortSignal.timeout(120_000);
      // The shared proxy fetcher retries replayable POST bodies after transport errors.
      // COSY request IDs/signatures cannot be replayed after an ambiguous send.
      const signedBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      });
      upstream = await this.fetchImpl(CHAT_URL, {
        method: "POST",
        headers,
        body: signedBody,
        duplex: "half",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      } as RequestInit & { duplex: "half" });
    } catch {
      return result(errorResponse(signal?.aborted ? 499 : 502, "Qoder CN connection failed"));
    }
    const wrapped = await wrapQoderCnSse(upstream, `qoder-cn/${modelKey}`);
    return result(
      stream ? wrapped : await collectCompletion(wrapped, `qoder-cn/${modelKey}`),
      headers,
      payload
    );
  }

  // CN device tokens have no supported refresh grant. Expiry requires a new login.
  async refreshCredentials(): Promise<null> {
    return null;
  }

  needsRefresh(): boolean {
    return false;
  }
}
