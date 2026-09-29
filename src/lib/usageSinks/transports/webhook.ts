/**
 * Signed HTTPS webhook (Standard Webhooks, https://www.standardwebhooks.com).
 *
 * Headers: `webhook-id` (the delivery id, stable across retries), `webhook-timestamp` and
 * `webhook-signature` = `v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">`. A secret written
 * as `whsec_<base64>` is used as those decoded bytes, any other secret as its UTF-8 bytes.
 *
 * Egress: HTTPS only and never a private or local address, whatever the private-provider-URL
 * opt-in says (a billing callback must not reach the internal network); redirects are refused.
 */
import { createHmac } from "node:crypto";
import { z } from "zod";
import { parseAndValidatePublicUrl } from "@/shared/network/outboundUrlGuard";
import {
  blankResult,
  createGuardedFetch,
  describeSendError,
  displayUrl,
  permanentFailure,
} from "./http";
import type { DeliveryResult, UsageSinkTransport } from "./types";

export interface WebhookConfig {
  url: string;
  secret: string;
}

export function signUsageWebhook(
  id: string,
  timestamp: string,
  body: string,
  secret: string
): string {
  const bytes = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice(6), "base64")
    : Buffer.from(secret, "utf8");
  return `v1,${createHmac("sha256", bytes).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

const webhookConfigSchema = z.object({
  url: z
    .string()
    .trim()
    .max(2048)
    .superRefine((value, ctx) => {
      try {
        const url = parseAndValidatePublicUrl(value);
        if (url.protocol !== "https:") ctx.addIssue({ code: "custom", message: "Must use HTTPS" });
      } catch {
        ctx.addIssue({ code: "custom", message: "Must be a public HTTPS URL" });
      }
    })
    .transform((value) => new URL(value).toString()),
  secret: z.string().min(16).max(1024),
});

export const webhookTransport: UsageSinkTransport<WebhookConfig> = {
  type: "webhook",
  label: "Webhook (HTTPS POST, signed)",
  description:
    "POSTs each delivery signed per Standard Webhooks; the webhook-id header is the stable delivery id.",
  secretFields: ["secret"],
  fields: [
    {
      key: "url",
      labelFallback: "Webhook URL",
      type: "text",
      required: true,
      placeholder: "https://billing.example.com/hooks/redrouter",
      helpFallback: "HTTPS only; private and local addresses are always refused.",
    },
    {
      key: "secret",
      labelFallback: "Signing secret",
      type: "password",
      required: true,
      secret: true,
      placeholder: "whsec_...",
      helpFallback: "At least 16 characters. Verify webhook-signature with it (HMAC-SHA256).",
    },
  ],
  configSchema: webhookConfigSchema as unknown as z.ZodType<WebhookConfig>,
  summary: (config) => `POST ${displayUrl(config.url) ?? ""}`,

  async send({ config, id, payload, now }, deps = {}): Promise<DeliveryResult> {
    const target = displayUrl(config.url);
    if (!config.url || !config.secret) return permanentFailure(target, "Webhook is not configured");
    const httpFetch = deps.httpFetch ?? createGuardedFetch({ allowPrivate: false });
    const started = Date.now();
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(now / 1000));
    try {
      const response = await httpFetch(config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "RedRouter-UsageSinks/1",
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": signUsageWebhook(id, timestamp, body, config.secret),
        },
        body,
      });
      await response.body?.cancel().catch(() => {});
      const result: DeliveryResult = {
        ...blankResult(target),
        durationMs: Date.now() - started,
        status: response.status,
        statusText: response.statusText || null,
      };
      if (response.ok) return { ...result, ok: true };
      // 410 Gone is the Standard Webhooks way to say "stop sending".
      return { ...result, retryable: response.status !== 410, error: `HTTP ${response.status}` };
    } catch (error) {
      return {
        ...blankResult(target),
        durationMs: Date.now() - started,
        error: describeSendError(error),
      };
    }
  },
};
