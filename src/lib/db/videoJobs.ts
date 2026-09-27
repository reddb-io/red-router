import { createHash, randomUUID } from "node:crypto";

import { getDbInstance } from "./core";

export type VideoJobAction = "generations" | "edits" | "extensions";
export type VideoJobState = "reserved" | "submitted" | "uncertain" | "failed";

export type VideoJob = {
  id: string;
  ownerHash: string;
  requestHash: string;
  action: VideoJobAction;
  provider: string;
  model: string;
  connectionId: string;
  upstreamRequestId: string | null;
  state: VideoJobState;
  createdAt: string;
  updatedAt: string;
};

type VideoJobRow = {
  id: string;
  owner_hash: string;
  request_hash: string;
  action: VideoJobAction;
  provider: string;
  model: string;
  connection_id: string;
  upstream_request_id: string | null;
  state: VideoJobState;
  created_at: string;
  updated_at: string;
};

export type ReserveVideoJobInput = {
  owner: string;
  idempotencyKey?: string | null;
  requestHash: string;
  action: VideoJobAction;
  provider: string;
  model: string;
  connectionId: string;
};

export type VideoJobReservation =
  | { kind: "created"; job: VideoJob }
  | { kind: "existing"; job: VideoJob }
  | { kind: "conflict"; job: VideoJob };

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function project(row: VideoJobRow): VideoJob {
  return {
    id: row.id,
    ownerHash: row.owner_hash,
    requestHash: row.request_hash,
    action: row.action,
    provider: row.provider,
    model: row.model,
    connectionId: row.connection_id,
    upstreamRequestId: row.upstream_request_id,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Reserve before the upstream create POST. A duplicate key returns the original
 * job without sending another billable request; a changed payload conflicts.
 * The database's unique constraint serializes competing worker processes.
 */
export function reserveVideoJob(input: ReserveVideoJobInput): VideoJobReservation {
  if (!input.owner || !input.connectionId || !/^[a-f0-9]{64}$/.test(input.requestHash)) {
    throw new Error("Invalid video job reservation");
  }
  const db = getDbInstance();
  const ownerHash = digest(input.owner);
  const idempotencyHash = input.idempotencyKey ? digest(input.idempotencyKey) : null;
  const now = new Date().toISOString();
  let outcome: VideoJobReservation | undefined;

  db.immediate(() => {
    if (idempotencyHash) {
      const existing = db
        .prepare("SELECT * FROM video_jobs WHERE owner_hash = ? AND idempotency_hash = ?")
        .get(ownerHash, idempotencyHash) as VideoJobRow | undefined;
      if (existing) {
        const job = project(existing);
        outcome = {
          kind: existing.request_hash === input.requestHash ? "existing" : "conflict",
          job,
        };
        return;
      }
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO video_jobs
       (id, owner_hash, idempotency_hash, request_hash, action, provider, model,
        connection_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`
    ).run(
      id,
      ownerHash,
      idempotencyHash,
      input.requestHash,
      input.action,
      input.provider,
      input.model,
      input.connectionId,
      now,
      now
    );
    const row = db.prepare("SELECT * FROM video_jobs WHERE id = ?").get(id) as VideoJobRow;
    outcome = { kind: "created", job: project(row) };
  });

  if (!outcome) throw new Error("Video job reservation did not complete");
  return outcome;
}

/** Only the owning API-key scope may read the account binding. */
export function getVideoJob(id: string, owner: string): VideoJob | null {
  if (!id || !owner) return null;
  const row = getDbInstance()
    .prepare("SELECT * FROM video_jobs WHERE id = ? AND owner_hash = ?")
    .get(id, digest(owner)) as VideoJobRow | undefined;
  return row ? project(row) : null;
}

/** Resolve a provider-native request ID only when its owner mapping is unique. */
export function getVideoJobByUpstreamId(id: string, owner: string): VideoJob | null {
  if (!id || !owner) return null;
  const rows = getDbInstance()
    .prepare(
      "SELECT * FROM video_jobs WHERE upstream_request_id = ? AND owner_hash = ? AND state = 'submitted' LIMIT 2"
    )
    .all(id, digest(owner)) as VideoJobRow[];
  return rows.length === 1 ? project(rows[0]) : null;
}

/** Read a prior reservation before selecting credentials for a retry. */
export function getVideoJobByIdempotency(owner: string, idempotencyKey: string): VideoJob | null {
  if (!owner || !idempotencyKey) return null;
  const row = getDbInstance()
    .prepare("SELECT * FROM video_jobs WHERE owner_hash = ? AND idempotency_hash = ?")
    .get(digest(owner), digest(idempotencyKey)) as VideoJobRow | undefined;
  return row ? project(row) : null;
}

export function markVideoJobSubmitted(id: string, upstreamRequestId: string): boolean {
  if (!upstreamRequestId) throw new Error("Video job needs an upstream request ID");
  return (
    getDbInstance()
      .prepare(
        `UPDATE video_jobs SET state = 'submitted', upstream_request_id = ?, updated_at = ?
         WHERE id = ? AND state = 'reserved'`
      )
      .run(upstreamRequestId, new Date().toISOString(), id).changes === 1
  );
}

/** Do not retry a submission whose remote result is ambiguous. */
export function markVideoJobUncertain(id: string): boolean {
  return transitionVideoJob(id, "uncertain");
}

/** The provider definitively rejected the submission before creating a job. */
export function markVideoJobFailed(id: string): boolean {
  return transitionVideoJob(id, "failed");
}

function transitionVideoJob(id: string, state: "uncertain" | "failed"): boolean {
  return (
    getDbInstance()
      .prepare(
        "UPDATE video_jobs SET state = ?, updated_at = ? WHERE id = ? AND state = 'reserved'"
      )
      .run(state, new Date().toISOString(), id).changes === 1
  );
}
