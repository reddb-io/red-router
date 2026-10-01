import { buildSetupReadiness } from "./readiness";
import type { SetupSelection } from "./progress";

interface KeyPolicy {
  id: string;
  isActive: boolean;
  isBanned: boolean;
  allowedConnections: string[];
  allowedEndpoints: string[];
}
interface ConnectionState {
  isActive?: unknown;
  displayName?: unknown;
  name?: unknown;
  provider?: unknown;
}
export interface SetupValidationDependencies {
  connection: (id: string) => Promise<ConnectionState | null>;
  metadata: (secret: string) => Promise<KeyPolicy | null>;
  validKey: (secret: string) => Promise<boolean>;
  modelAllowed: (secret: string, model: string) => Promise<boolean>;
  models: (connectionId: string) => Promise<readonly { fullModel?: string }[]>;
}

/** Validate exactly the chosen credential/model/account without allocating inference quota. */
export async function validateSetupSelection(
  selection: SetupSelection & { apiKey: string },
  deps: SetupValidationDependencies
) {
  const { connectionId, model, apiKeyId, apiKey } = selection;
  const connection = await deps.connection(connectionId);
  const metadata = await deps.metadata(apiKey);
  const keyValid =
    !!metadata &&
    metadata.id === apiKeyId &&
    metadata.isActive !== false &&
    !metadata.isBanned &&
    (await deps.validKey(apiKey));
  const connectionAllowed =
    keyValid &&
    (!metadata.allowedConnections.length || metadata.allowedConnections.includes(connectionId));
  const active = Boolean(connection && connection.isActive !== false);
  let modelAvailable = false;
  // No account discovery outside the supplied credential's effective tenant policy.
  if (active && connectionAllowed) {
    modelAvailable = (await deps.models(connectionId)).some((entry) => entry.fullModel === model);
  }
  const connectionName = [connection?.displayName, connection?.name, connection?.provider].find(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  return buildSetupReadiness({
    connectionName,
    connectionActive: active,
    keyValid,
    connectionAllowed,
    modelAvailable,
    modelAllowed: keyValid && (await deps.modelAllowed(apiKey, model)),
    endpointAllowed:
      keyValid && (!metadata.allowedEndpoints.length || metadata.allowedEndpoints.includes("chat")),
  });
}
