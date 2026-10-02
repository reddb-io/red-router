import { getDbInstance } from "./core";

export interface ModelsDevSnapshotMetadata {
  source: "https://models.dev/api.json" | "https://models.dev/api.json?type=all";
  fetchedAt: string;
  savedAt: string;
  sha256: string;
  checkedAt?: string;
  etag?: string | null;
  lastModified?: string | null;
  transformVersion?: number;
  modelCount?: number;
  providerCount?: number;
  capabilityCount?: number;
  capabilitiesSynced?: boolean;
}

/** Pricing, capabilities and provenance commit together or keep the previous snapshot. */
export function commitModelsDevSnapshot(
  metadata: ModelsDevSnapshotMetadata,
  write: () => void,
  publicData?: unknown
): void {
  const db = getDbInstance();
  db.transaction(() => {
    write();
    if (publicData !== undefined) {
      db.prepare(
        "INSERT INTO key_value(namespace, key, value) VALUES ('models_dev_snapshot', 'public_data', ?) ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value"
      ).run(JSON.stringify(publicData));
    }
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
    const metadata = JSON.parse(row.value) as ModelsDevSnapshotMetadata;
    if (
      (metadata.source !== "https://models.dev/api.json" &&
        metadata.source !== "https://models.dev/api.json?type=all") ||
      typeof metadata.fetchedAt !== "string" ||
      typeof metadata.savedAt !== "string" ||
      typeof metadata.sha256 !== "string"
    ) {
      return null;
    }
    return metadata;
  } catch {
    return null;
  }
}

/** Safe public metadata only; provider credentials/body/headers are never stored here. */
export function readModelsDevSnapshotData(): unknown | null {
  const row = getDbInstance()
    .prepare(
      "SELECT value FROM key_value WHERE namespace = 'models_dev_snapshot' AND key = 'public_data'"
    )
    .get() as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

/** A cleared overlay must be rebuilt even if upstream next answers 304. */
export function clearModelsDevSnapshot(): void {
  getDbInstance().prepare("DELETE FROM key_value WHERE namespace = 'models_dev_snapshot'").run();
}
