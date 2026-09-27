import {
  DECISION_HEADER,
  HINT_HEADER,
  decisionOptOut,
  parseClassificationHint,
} from "@omniroute/open-sse/decision/clientHint.ts";

/** Parse request-scoped hints without persisting or forwarding either header. */
export function resolveJevClientControls(headers: Headers) {
  const decisionHint = parseClassificationHint(headers.get(HINT_HEADER));
  const decisionHeader = headers.get(DECISION_HEADER);
  return {
    decisionHint,
    decisionModelOptOut: decisionOptOut(decisionHeader, decisionHint).model,
    decisionServerOptOut: decisionHeader?.trim().toLowerCase() === "off",
  };
}
