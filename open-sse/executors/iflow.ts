import { createHmac, randomUUID } from "node:crypto";
import { DefaultExecutor } from "./default.ts";
import type { ProviderCredentials } from "./base.ts";

const DEFAULT_USER_AGENT = "iFlow-Cli";

/**
 * IFlowExecutor — iFlow AI (iflow.cn) OpenAI-compatible gateway.
 *
 * Ported from the legacy fork (open-sse/executors/iflow.js @ c66f917c). Every
 * request carries an HMAC-SHA256 signature over `${userAgent}:${sessionId}:${ts}`,
 * keyed by the connection credential (apiKey, or the OAuth accessToken), plus a
 * per-request `session-id` and millisecond timestamp.
 */
export class IFlowExecutor extends DefaultExecutor {
  constructor() {
    super("iflow");
  }

  createIFlowSignature(
    userAgent: string,
    sessionId: string,
    timestamp: number,
    apiKey: string
  ): string {
    if (!apiKey) return "";
    const hmac = createHmac("sha256", apiKey);
    hmac.update(`${userAgent}:${sessionId}:${timestamp}`);
    return hmac.digest("hex");
  }

  buildHeaders(credentials: ProviderCredentials, stream = true): Record<string, string> {
    const headers = super.buildHeaders(credentials, stream);

    const sessionId = `session-${randomUUID()}`;
    const timestamp = Date.now();
    const userAgent =
      (this.config?.headers?.["User-Agent"] as string | undefined) || DEFAULT_USER_AGENT;
    const apiKey = credentials.apiKey || credentials.accessToken || "";

    headers["session-id"] = sessionId;
    headers["x-iflow-timestamp"] = String(timestamp);
    headers["x-iflow-signature"] = this.createIFlowSignature(
      userAgent,
      sessionId,
      timestamp,
      apiKey
    );

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  transformRequest(
    model: string,
    body: unknown,
    stream: boolean,
    credentials: ProviderCredentials
  ): unknown {
    const transformed = super.transformRequest(model, body, stream, credentials);
    if (stream && transformed && typeof transformed === "object" && !Array.isArray(transformed)) {
      const out = transformed as Record<string, unknown>;
      if (Array.isArray(out.messages) && !out.stream_options) {
        out.stream_options = { include_usage: true };
      }
    }
    return transformed;
  }
}

export default IFlowExecutor;
