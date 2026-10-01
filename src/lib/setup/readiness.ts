/** Configuration checks are free of inference and do not prove upstream availability. */
export interface SetupCheck {
  id: "server" | "provider" | "apiKey" | "model";
  status: "pass" | "fail";
  message: string;
}
export interface SetupReadiness {
  status: "ready" | "action_required";
  inferenceTested: false;
  checks: SetupCheck[];
}

export function buildSetupReadiness(input: {
  connectionName?: string | null;
  connectionActive: boolean;
  keyValid: boolean;
  connectionAllowed: boolean;
  modelAvailable: boolean;
  modelAllowed: boolean;
  endpointAllowed: boolean;
}): SetupReadiness {
  const checks: SetupCheck[] = [
    { id: "server", status: "pass", message: "RedRouter server is responding." },
    {
      id: "provider",
      status: input.connectionActive && input.connectionAllowed ? "pass" : "fail",
      message: !input.connectionActive
        ? "Choose an active provider connection."
        : !input.connectionAllowed
          ? "The selected key or its tenant does not allow this connection."
          : `${input.connectionName || "The selected connection"} is active and allowed by this key.`,
    },
    {
      id: "apiKey",
      status: input.keyValid && input.endpointAllowed ? "pass" : "fail",
      message: !input.keyValid
        ? "Enter the secret for the selected active client key, or create a new key."
        : !input.endpointAllowed
          ? "This key does not allow the chat endpoint."
          : "The selected client key is valid and allows chat requests.",
    },
    {
      id: "model",
      status: input.modelAvailable && input.modelAllowed ? "pass" : "fail",
      message: !input.modelAvailable
        ? "Choose a chat model available in this connection's catalog."
        : !input.modelAllowed
          ? "The selected key does not allow this model."
          : "The selected model is listed and allowed by this key.",
    },
  ];
  return {
    status: checks.every((check) => check.status === "pass") ? "ready" : "action_required",
    inferenceTested: false,
    checks,
  };
}
