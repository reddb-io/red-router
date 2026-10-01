import { getDbInstance } from "./core";

export interface ModelsDevSnapshotMetadata {
  source: "https://models.dev/api.json";
  fetchedAt: string;
  savedAt: string;
  sha256: string;
}

/** Pricing, capabilities and provenance commit together or keep the previous snapshot. */
export function commitModelsDevSnapshot(
  metadata: ModelsDevSnapshotMetadata,
  write: () => void
): void {
  const db = getDbInstance();
  db.transaction(() => {
    write();
    db.prepare(
      "INSERT INTO key_value(namespace, key, value) VALUES ('models_dev_snapshot', 'metadata', ?) ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value"
    ).run(JSON.stringify(metadata));
  })();
}

export function readModelsDevSnapshotMetadata(): ModelsDevSnapshotMetadata | null {
  const row = getDbInstance()
    .prepare(
      "SELECT value FROM key_value WHERE namespace = 'models_dev_snapshot' AND key = 'metadata'"
    )
    .get() as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}
