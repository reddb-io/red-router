import { RED_ROUTER_REASONING_RESPONSE_HEADER } from "@/shared/constants/redRouterHeaders";
import {
  reasoningResponseHeaderValue,
  type ReasoningPlan,
} from "@/sse/services/reasoningPlanner";

// The plan is decided deep inside the chat handler; the response leaves through the admission
// wrapper. The request object is the key that connects them, and it is garbage-collected with it.
const plans = new WeakMap<object, ReasoningPlan>();

export function rememberReasoningPlan(request: object, plan: ReasoningPlan): void {
  plans.set(request, plan);
}

/** Reports the reasoning level the autopilot (or the request header) chose on a successful answer. */
export function withReasoningHeader(request: object, response: Response): Response {
  const plan = plans.get(request);
  if (!plan || !response || response.status >= 400) return response;
  const value = reasoningResponseHeaderValue(plan);
  try {
    response.headers.set(RED_ROUTER_REASONING_RESPONSE_HEADER, value);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set(RED_ROUTER_REASONING_RESPONSE_HEADER, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
