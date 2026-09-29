/** RedRouter's guided-setup response contract, independent of the probe transport. */
export interface SetupCheck {
  id: "server" | "provider" | "apiKey";
  status: "pass" | "fail";
  message: string;
}

export interface SetupReadiness {
  status: "ready" | "action_required";
  checks: SetupCheck[];
}

export function buildSetupReadiness(input: {
  connectionName?: string | null;
  connectionActive: boolean;
  providerValid: boolean;
  providerError?: string | null;
  hasActiveKey: boolean;
}): SetupReadiness {
  const checks: SetupCheck[] = [
    { id: "server", status: "pass", message: "RedRouter server is responding." },
    {
      id: "provider",
      status: input.connectionActive && input.providerValid ? "pass" : "fail",
      message: !input.connectionActive
        ? "Choose an active provider connection."
        : input.providerValid
          ? `${input.connectionName || "The selected provider"} passed its connection test.`
          : input.providerError || "The selected provider connection failed validation.",
    },
    {
      id: "apiKey",
      status: input.hasActiveKey ? "pass" : "fail",
      message: input.hasActiveKey
        ? "An active API key is available for clients."
        : "Create or resume an API key.",
    },
  ];
  return {
    status: checks.every((check) => check.status === "pass") ? "ready" : "action_required",
    checks,
  };
}
