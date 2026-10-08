import { RoutingStorageError, type RoutingStorageConfig } from "./routingStorageConfig";
import { emptyRoutingSnapshot, type RoutingSnapshotStorage } from "./routingSnapshotStore";

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}
interface SqlClient {
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
  release(destroy?: boolean): void;
}
interface SqlPool {
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
  connect(): Promise<SqlClient>;
  on(event: "error", listener: () => void): void;
  end(): Promise<void>;
}

export const ROUTING_STATE_SCHEMA = `CREATE TABLE IF NOT EXISTS redrouter_routing_state (
  id TEXT PRIMARY KEY,
  revision BIGINT NOT NULL,
  snapshot_json TEXT NOT NULL
)`;

/** PostgreSQL wire is a transport; RedDB is tested independently of PostgreSQL. */
export class PgRoutingSnapshotStorage implements RoutingSnapshotStorage {
  private poolPromise: Promise<SqlPool> | undefined;
  constructor(private readonly config: RoutingStorageConfig) {}

  private pool(): Promise<SqlPool> {
    if (!this.poolPromise) {
      this.poolPromise = (async () => {
        try {
          const pg = await import("pg");
          const pool = new pg.Pool({
            connectionString: this.config.databaseUrl,
            max: 4,
            connectionTimeoutMillis: 5000,
            query_timeout: 5000,
            idleTimeoutMillis: 30000,
            allowExitOnIdle: true,
          }) as SqlPool;
          // Client-specific errors reject the operation; idle errors must not crash Node.
          pool.on("error", () => console.warn("Routing storage idle connection failed"));
          return pool;
        } catch {
          this.poolPromise = undefined;
          throw new RoutingStorageError("unavailable");
        }
      })();
    }
    return this.poolPromise;
  }

  async load(): Promise<{ revision: number; data: string }> {
    try {
      const { rows } = await (
        await this.pool()
      ).query("SELECT revision, snapshot_json FROM redrouter_routing_state WHERE id = $1", [
        "routing",
      ]);
      const row = rows[0];
      if (!row) throw new RoutingStorageError("not_initialized");
      const revision = Number(row.revision);
      if (
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        typeof row.snapshot_json !== "string"
      ) {
        throw new RoutingStorageError("invalid_snapshot");
      }
      return { revision, data: row.snapshot_json };
    } catch (error) {
      if (error instanceof RoutingStorageError) throw error;
      throw new RoutingStorageError("unavailable");
    }
  }

  async compareAndSwap(revision: number, data: string): Promise<boolean> {
    try {
      const { rowCount } = await (
        await this.pool()
      ).query(
        "UPDATE redrouter_routing_state SET revision = $1, snapshot_json = $2 WHERE id = $3 AND revision = $4",
        [revision + 1, data, "routing", revision]
      );
      if (rowCount !== 0 && rowCount !== 1) throw new RoutingStorageError("invalid_snapshot");
      return rowCount === 1;
    } catch (error) {
      if (error instanceof RoutingStorageError) throw error;
      throw new RoutingStorageError("unavailable");
    }
  }

  /** Explicit maintenance operation; ordinary requests never run DDL or seed data. */
  async initialize(): Promise<void> {
    let client: SqlClient | undefined;
    let destroy = false;
    try {
      client = await (await this.pool()).connect();
      // The operator owns exclusivity: all application writers must be stopped.
      // Do not assume PostgreSQL advisory-lock support on RedDB. The unique row
      // prevents a racing initializer from overwriting an existing snapshot.
      await client.query(ROUTING_STATE_SCHEMA);
      const current = await client.query("SELECT id FROM redrouter_routing_state WHERE id = $1", [
        "routing",
      ]);
      if (!current.rows.length) {
        await client.query(
          "INSERT INTO redrouter_routing_state (id, revision, snapshot_json) VALUES ($1, $2, $3)",
          ["routing", 0, JSON.stringify(emptyRoutingSnapshot())]
        );
      }
    } catch (error) {
      destroy = true;
      if (error instanceof RoutingStorageError) throw error;
      throw new RoutingStorageError("unavailable");
    } finally {
      client?.release(destroy);
    }
  }

  async close(): Promise<void> {
    const pool = this.poolPromise;
    this.poolPromise = undefined;
    if (pool) await (await pool).end();
  }
}
