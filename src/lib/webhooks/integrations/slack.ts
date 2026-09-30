import type { WebhookEvent } from "../eventDescriptions";
import { EVENT_DESCRIPTIONS } from "../eventDescriptions";

export interface SlackPayload {
  text: string;
  blocks?: unknown[];
}

export function buildSlackPayload(
  event: WebhookEvent,
  data: Record<string, unknown>
): SlackPayload {
  const desc = EVENT_DESCRIPTIONS[event];
  const model = typeof data.model === "string" ? data.model : null;
  const provider = typeof data.provider === "string" ? data.provider : null;
  const error = typeof data.error === "string" ? data.error : null;

  const titleParts = [`${desc.emoji} *${desc.label}*`];
  if (model) titleParts.push(`on \`${model}\``);

  const lines: string[] = [titleParts.join(" ")];
  if (error) lines.push(`*Error:* \`${error}\``);
  if (provider && !model) lines.push(`*Provider:* ${provider}`);
  if (typeof data.state === "string") lines.push(`*State:* \`${data.state}\``);
  if (typeof data.reason === "string") lines.push(`*Reason:* \`${data.reason}\``);

  const text = lines.join("\n");

  return {
    text,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `RedRouter · ${new Date().toISOString()}`,
          },
        ],
      },
    ],
  };
}
