import { z } from "zod";

export type RoutingBackend = "sqlite" | "reddb" | "postgres";

const configSchema = z
  .object({
    backend: z.enum(["sqlite", "reddb", "postgres"]).default("sqlite"),
    databaseUrl: z.string().max(4096).optional(),
  })
  .superRefine((config, context) => {
    if (config.backend === "sqlite") return;
    try {
      const url = new URL(config.databaseUrl || "");
      if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) throw new Error();
    } catch {
      context.addIssue({ code: "custom", message: "A PostgreSQL-wire database URL is required" });
    }
  });

export interface RoutingStorageConfig {
  backend: RoutingBackend;
  databaseUrl?: string;
}

export type RoutingStorageErrorCode =
  | "configuration"
  | "unavailable"
  | "not_initialized"
  | "invalid_snapshot"
  | "conflict"
  | "already_exists"
  | "unsupported_operation";

const messages: Record<RoutingStorageErrorCode, string> = {
  configuration: "Invalid routing storage configuration",
  unavailable: "The configured routing database is unavailable",
  not_initialized: "The configured routing database has not been initialized",
  invalid_snapshot: "The routing database contains an unsupported or invalid snapshot",
  conflict: "Routing configuration changed concurrently; retry the operation",
  already_exists: "A combo with this name or ID already exists",
  unsupported_operation:
    "This operation requires complete SQLite persistence; external routing storage is experimental",
};

/** Fixed public messages: driver errors and connection strings never escape this boundary. */
export class RoutingStorageError extends Error {
  readonly status: number;
  constructor(readonly code: RoutingStorageErrorCode) {
    super(messages[code]);
    this.name = "RoutingStorageError";
    this.status =
      code === "conflict" || code === "already_exists" || code === "unsupported_operation"
        ? 409
        : code === "configuration" || code === "invalid_snapshot"
          ? 500
          : 503;
  }
}

export function readRoutingStorageConfig(
  env: NodeJS.ProcessEnv = process.env
): RoutingStorageConfig {
  const parsed = configSchema.safeParse({
    backend: env.RED_ROUTER_ROUTING_BACKEND,
    databaseUrl: env.RED_ROUTER_ROUTING_DATABASE_URL,
  });
  if (!parsed.success) throw new RoutingStorageError("configuration");
  return parsed.data as RoutingStorageConfig;
}

/** Whole-database operations cannot represent the experimental mixed-store deployment. */
export function requireCompleteSqlitePersistence(): void {
  if (readRoutingStorageConfig().backend !== "sqlite")
    throw new RoutingStorageError("unsupported_operation");
}
