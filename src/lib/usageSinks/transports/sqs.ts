/**
 * Amazon SQS: `SendMessage` over the SQS JSON protocol, signed with SigV4 through the repo's
 * existing signer (`open-sse/utils/awsSigV4.ts`, also used by the Polly executor), so no AWS SDK
 * is pulled in. Works with any SQS-compatible endpoint (LocalStack, ElasticMQ) at the queue
 * URL's origin.
 *
 * Message identity: every message carries the delivery id in the `redrouter-delivery-id`
 * attribute. A FIFO queue (`.fifo`) also gets `MessageDeduplicationId` = delivery id, so a
 * retried delivery is not enqueued twice inside SQS's 5-minute dedup window, and
 * `MessageGroupId` = sink id, so one sink's deliveries stay in order. A standard queue is
 * at-least-once: consumers dedupe on the attribute.
 *
 * Egress: an AWS host (`sqs.<region>.amazonaws.com[.cn]`) must be HTTPS; any other endpoint is
 * accepted only through the same guard as every other outbound URL (cloud metadata always
 * refused, private/local addresses only with the private-provider-URL opt-in), and the request
 * itself goes through the DNS-pinned, no-redirect guarded fetch.
 */
import { z } from "zod";
import { signAwsRequest } from "@omniroute/open-sse/utils/awsSigV4.ts";
import {
  blankResult,
  createGuardedFetch,
  describeSendError,
  displayUrl,
  egressUrlIssue,
  permanentFailure,
  readResponse,
  remoteDetail,
} from "./http";
import type { DeliveryResult, UsageSinkTransport } from "./types";

/** SQS rejects a message body over 256 KiB. */
export const SQS_MAX_MESSAGE_BYTES = 262_144;

export interface SqsConfig {
  queueUrl: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** The region in an AWS queue URL (`https://sqs.us-east-1.amazonaws.com/...`), or null. */
export function regionFromQueueUrl(queueUrl: string): string | null {
  try {
    return (
      new URL(queueUrl).hostname.match(/^sqs\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?$/)?.[1] ?? null
    );
  } catch {
    return null;
  }
}

export const isFifoQueue = (queueUrl: string): boolean =>
  /\.fifo$/.test(String(queueUrl || "").replace(/\/+$/, ""));

const isAwsHost = (queueUrl: string): boolean => regionFromQueueUrl(queueUrl) !== null;

const sqsConfigSchema = z
  .object({
    queueUrl: z.string().trim().max(2048),
    region: z
      .string()
      .trim()
      .max(32)
      .regex(/^[a-z0-9-]*$/, "Use a region such as us-east-1")
      .optional()
      .default(""),
    accessKeyId: z.string().trim().min(1).max(128),
    secretAccessKey: z.string().min(1).max(1024),
    sessionToken: z.string().max(4096).optional(),
  })
  .superRefine((config, ctx) => {
    const issue = egressUrlIssue(config.queueUrl, ["https:", "http:"]);
    if (issue) return ctx.addIssue({ code: "custom", path: ["queueUrl"], message: issue });
    if (isAwsHost(config.queueUrl) && !config.queueUrl.startsWith("https:")) {
      ctx.addIssue({ code: "custom", path: ["queueUrl"], message: "AWS endpoints must use HTTPS" });
    }
    if (!config.region && !regionFromQueueUrl(config.queueUrl)) {
      ctx.addIssue({
        code: "custom",
        path: ["region"],
        message: "Region is required for a queue URL outside amazonaws.com",
      });
    }
  })
  .transform((config): SqsConfig => ({
    ...config,
    region: config.region || (regionFromQueueUrl(config.queueUrl) as string),
    sessionToken: config.sessionToken || undefined,
  }));

export const sqsTransport: UsageSinkTransport<SqsConfig> = {
  type: "sqs",
  label: "Amazon SQS",
  description:
    "SendMessage with the delivery id as an attribute; FIFO queues deduplicate on it and keep a sink's deliveries ordered.",
  secretFields: ["secretAccessKey", "sessionToken"],
  fields: [
    {
      key: "queueUrl",
      labelFallback: "Queue URL",
      type: "text",
      required: true,
      placeholder: "https://sqs.us-east-1.amazonaws.com/123456789012/usage",
      helpFallback:
        "A .fifo queue gets the delivery id as MessageDeduplicationId, so a retry is not enqueued twice.",
    },
    {
      key: "region",
      labelFallback: "Region",
      type: "text",
      placeholder: "Read from the queue URL",
    },
    { key: "accessKeyId", labelFallback: "Access key id", type: "text", required: true },
    {
      key: "secretAccessKey",
      labelFallback: "Secret access key",
      type: "password",
      required: true,
      secret: true,
      helpFallback: "The key needs sqs:SendMessage on this queue.",
    },
    {
      key: "sessionToken",
      labelFallback: "Session token (optional)",
      type: "password",
      secret: true,
      helpFallback: "For temporary credentials.",
    },
  ],
  configSchema: sqsConfigSchema,
  summary: (config) =>
    `SQS ${String(config.queueUrl || "")
      .split("/")
      .pop()} (${config.region || "?"})`,

  async send({ config, id, sinkId, payload, now }, deps = {}): Promise<DeliveryResult> {
    const target = displayUrl(config.queueUrl);
    const region = config.region || regionFromQueueUrl(config.queueUrl);
    if (!config.queueUrl || !region) {
      return permanentFailure(target, "An SQS queue URL and region are required");
    }
    if (!config.accessKeyId || !config.secretAccessKey) {
      return permanentFailure(target, "AWS access key id and secret access key are required");
    }
    const messageBody = JSON.stringify(payload);
    if (Buffer.byteLength(messageBody) > SQS_MAX_MESSAGE_BYTES) {
      return permanentFailure(target, "Payload exceeds the 256 KiB SQS message limit");
    }

    const endpoint = `${new URL(config.queueUrl).origin}/`;
    const body = JSON.stringify({
      QueueUrl: config.queueUrl,
      MessageBody: messageBody,
      MessageAttributes: { "redrouter-delivery-id": { DataType: "String", StringValue: id } },
      ...(isFifoQueue(config.queueUrl)
        ? { MessageGroupId: sinkId, MessageDeduplicationId: id.slice(0, 128) }
        : {}),
    });
    const { host: _host, ...headers } = signAwsRequest({
      method: "POST",
      url: endpoint,
      region,
      service: "sqs",
      headers: {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": "AmazonSQS.SendMessage",
      },
      body,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        sessionToken: config.sessionToken || undefined,
      },
      now: new Date(now),
    });

    const httpFetch = deps.httpFetch ?? createGuardedFetch();
    const started = Date.now();
    try {
      const response = await httpFetch(endpoint, { method: "POST", headers, body });
      const { result, text } = await readResponse(response, blankResult(target), started);
      if (response.ok) return { ...result, ok: true };
      // Retried like the webhook: credentials and queue policies get fixed while it waits.
      let detail = remoteDetail(text);
      try {
        const parsed = JSON.parse(text) as { __type?: string; message?: string; Message?: string };
        detail =
          remoteDetail(
            [parsed.__type?.split("#").pop(), parsed.message || parsed.Message]
              .filter(Boolean)
              .join(": ")
          ) || detail;
      } catch {
        // Not JSON: keep the trimmed text.
      }
      return { ...result, error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
    } catch (error) {
      return {
        ...blankResult(target),
        durationMs: Date.now() - started,
        error: describeSendError(error),
      };
    }
  },
};
