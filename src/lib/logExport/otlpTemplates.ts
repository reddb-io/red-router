/**
 * Presets for the OTLP log-export destination.
 *
 * The destination form is generated from field descriptors and cannot pre-fill one field
 * from another, so presets are served read-only (GET /api/log-export/otlp-templates) for
 * the dashboard to offer. A template carries no credential: endpoint and header lines hold
 * `<placeholders>` that {@link fillOtlpTemplate} replaces with the operator's values.
 *
 * Every template was written from the vendor's public documentation without network
 * access, so none has been exercised live. `verified` records how sure that recollection
 * is: false means the endpoint, the auth scheme or logs ingestion should be checked
 * against the vendor's docs before relying on it (see `notes`).
 */

export interface OtlpTemplate {
  id: string;
  label: string;
  /** Endpoint to store; `<placeholders>` must be replaced first. */
  endpoint: string;
  /**
   * True when `endpoint` is the complete logs URL and the exporter must not append
   * `/v1/logs` (sets the destination's `endpointIsFull`). Every current template uses the
   * standard OTLP path, so this is false; it exists for vendors with a different one.
   */
  endpointIsFull: boolean;
  /** One `Name: value` per line, as the destination's headers field expects. */
  headers: string;
  /** Names of the `<placeholders>` used above, in the order an operator meets them. */
  placeholders: readonly string[];
  /** Whether endpoint, auth and logs ingestion match the vendor docs as recalled. */
  verified: boolean;
  docsUrl: string;
  notes: string;
}

export const OTLP_TEMPLATES: readonly OtlpTemplate[] = [
  {
    id: "langfuse",
    label: "Langfuse",
    endpoint: "https://cloud.langfuse.com/api/public/otel",
    endpointIsFull: false,
    headers: ["Authorization: Basic <basic-auth>", "x-langfuse-ingestion-version: 4"].join("\n"),
    placeholders: ["basic-auth"],
    verified: false,
    docsUrl: "https://langfuse.com/docs/opentelemetry/get-started",
    notes:
      "<basic-auth> is base64(publicKey:secretKey); use langfuseHeaders(). EU cloud shown; US is https://us.cloud.langfuse.com/api/public/otel. Langfuse documents its OTLP endpoint for traces; whether it accepts /v1/logs is unconfirmed, so run the destination test before enabling.",
  },
  {
    id: "helicone",
    label: "Helicone",
    endpoint: "https://api.helicone.ai/otel",
    endpointIsFull: false,
    headers: "Authorization: Bearer <api-key>",
    placeholders: ["api-key"],
    verified: false,
    docsUrl: "https://docs.helicone.ai",
    notes:
      "Endpoint and path are not confirmed against Helicone's docs. Helicone's OpenTelemetry ingestion may be trace-oriented; confirm the URL there, then set endpointIsFull if it differs from the standard /v1/logs path.",
  },
  {
    id: "braintrust",
    label: "Braintrust",
    endpoint: "https://api.braintrust.dev/otel",
    endpointIsFull: false,
    headers: ["Authorization: Bearer <api-key>", "x-bt-parent: project_id:<project-id>"].join("\n"),
    placeholders: ["api-key", "project-id"],
    verified: false,
    docsUrl: "https://www.braintrust.dev/docs/guides/traces/integrations",
    notes:
      "Braintrust documents this endpoint for traces (/otel/v1/traces). Whether /otel/v1/logs is accepted is unconfirmed; run the destination test before enabling.",
  },
  {
    id: "grafana-cloud",
    label: "Grafana Cloud",
    endpoint: "https://otlp-gateway-<zone>.grafana.net/otlp",
    endpointIsFull: false,
    headers: "Authorization: Basic <basic-auth>",
    placeholders: ["zone", "basic-auth"],
    verified: true,
    docsUrl: "https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/",
    notes:
      "<zone> is your stack's region (for example prod-us-central-0). <basic-auth> is base64(instanceId:accessPolicyToken) with the logs:write scope; see basicAuthValue(). Logs land in Loki.",
  },
  {
    id: "honeycomb",
    label: "Honeycomb",
    endpoint: "https://api.honeycomb.io",
    endpointIsFull: false,
    headers: "x-honeycomb-team: <api-key>",
    placeholders: ["api-key"],
    verified: true,
    docsUrl: "https://docs.honeycomb.io/send-data/opentelemetry/",
    notes:
      "US region shown; EU is https://api.eu1.honeycomb.io. The API key needs permission to create datasets; the dataset comes from the service name.",
  },
  {
    id: "local-collector",
    label: "Local collector (http://localhost:4318)",
    endpoint: "http://localhost:4318",
    endpointIsFull: false,
    headers: "",
    placeholders: [],
    verified: true,
    docsUrl: "https://opentelemetry.io/docs/collector/",
    notes:
      "The default OTLP/HTTP port of the OpenTelemetry Collector. A loopback collector is only reachable with the operator's private-URL opt-in (OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS).",
  },
];

export function getOtlpTemplate(id: string): OtlpTemplate | undefined {
  return OTLP_TEMPLATES.find((template) => template.id === id);
}

/** `Basic base64(user:secret)`'s payload, for `Authorization: Basic <value>`. */
export function basicAuthValue(user: string, secret: string): string {
  return Buffer.from(`${user}:${secret}`, "utf8").toString("base64");
}

/** Replaces `<name>` tokens; a token with no supplied value is left in place. */
export function fillOtlpTemplate(text: string, values: Record<string, string>): string {
  return text.replace(/<([a-z][a-z0-9-]*)>/g, (token, name: string) =>
    Object.hasOwn(values, name) ? values[name] : token
  );
}

/**
 * Header lines for the Langfuse template: `Authorization: Basic base64(publicKey:secretKey)`
 * plus the ingestion-version header.
 */
export function langfuseHeaders(publicKey: string, secretKey: string): string {
  const langfuse = getOtlpTemplate("langfuse") as OtlpTemplate;
  return fillOtlpTemplate(langfuse.headers, {
    "basic-auth": basicAuthValue(publicKey, secretKey),
  });
}

/** A template's endpoint and headers with the operator's values filled in. */
export function renderOtlpTemplate(
  template: OtlpTemplate,
  values: Record<string, string>
): { endpoint: string; headers: string; endpointIsFull: boolean } {
  return {
    endpoint: fillOtlpTemplate(template.endpoint, values),
    headers: fillOtlpTemplate(template.headers, values),
    endpointIsFull: template.endpointIsFull,
  };
}
