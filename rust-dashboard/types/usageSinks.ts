/** Rust SPA view models returned by the Rust-owned usage export API. */
export interface FieldDescriptor {
  key: string;
  labelFallback: string;
  type: "text" | "password" | "textarea" | "number" | "boolean" | "select";
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  helpFallback?: string;
  options?: Array<{ value: string; labelFallback: string }>;
}

export interface TransportDescriptor {
  type: string;
  label: string;
  description: string;
  fields: FieldDescriptor[];
  modes?: Array<"instant" | "window">;
}

export interface UsageSink {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  mode: "instant" | "window";
  windowSec: number | null;
  apiKeyIds: string[];
  config: Record<string, unknown>;
  summary: string;
  enabled: boolean;
  nextWindowEnd: string | null;
  createdAt: string;
  deliveries: { pending: number; delivered: number; dead: number };
  deliveryHistory?: boolean;
}
