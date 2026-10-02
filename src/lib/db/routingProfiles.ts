import { randomUUID } from "node:crypto";
import { getDbInstance } from "./core";
import { invalidateDbCache } from "./readCache";

export interface RoutingProfile {
  id: string;
  name: string;
  transparent: boolean | null;
  providerPriority: string[] | null;
  updatedAt: string;
}

export interface ProfileBinding {
  profileId: string;
  transparent: boolean | null;
  providerPriority: string[] | null;
}

export class RoutingProfileError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

type Row = Record<string, unknown>;
const scopeFor = (tenantId?: string | null) => (tenantId ? `tenant:${tenantId}` : "instance");
const booleanValue = (value: unknown) => (value == null ? null : Number(value) === 1);
const listValue = (value: unknown): string[] | null => {
  if (typeof value !== "string") return null;
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : null;
};
function fromRow(row: Row): RoutingProfile {
  return {
    id: String(row.id),
    name: String(row.name),
    transparent: booleanValue(row.transparent),
    providerPriority: listValue(row.priority),
    updatedAt: String(row.updated_at),
  };
}

export function getRoutingProfile(id: string): RoutingProfile | null {
  const row = getDbInstance().prepare("SELECT * FROM routing_profiles WHERE id = ?").get(id) as
    Row | undefined;
  return row ? fromRow(row) : null;
}

export function listRoutingProfiles(): (RoutingProfile & { attachments: number })[] {
  const rows = getDbInstance()
    .prepare(
      `SELECT p.*, COUNT(b.scope) AS attachments FROM routing_profiles p
    LEFT JOIN routing_profile_bindings b ON b.profile_id = p.id GROUP BY p.id ORDER BY p.name, p.id`
    )
    .all() as Row[];
  return rows.map((row) => ({ ...fromRow(row), attachments: Number(row.attachments) }));
}

export function saveRoutingProfile(
  input: Pick<RoutingProfile, "name" | "transparent" | "providerPriority">,
  id?: string
): RoutingProfile {
  const profileId = id ?? randomUUID();
  const db = getDbInstance();
  db.transaction(() => {
    if (id && !getRoutingProfile(id))
      throw new RoutingProfileError(404, "Routing profile not found.");
    db.prepare(
      `INSERT INTO routing_profiles (id, name, transparent, priority, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, transparent = excluded.transparent,
        priority = excluded.priority, updated_at = excluded.updated_at`
    ).run(
      profileId,
      input.name,
      input.transparent === null ? null : input.transparent ? 1 : 0,
      input.providerPriority === null ? null : JSON.stringify(input.providerPriority),
      new Date().toISOString()
    );
  })();
  invalidateDbCache("settings");
  return getRoutingProfile(profileId)!;
}

export function deleteRoutingProfile(id: string): void {
  const db = getDbInstance();
  db.transaction(() => {
    if (!getRoutingProfile(id)) throw new RoutingProfileError(404, "Routing profile not found.");
    if (
      db.prepare("SELECT scope FROM routing_profile_bindings WHERE profile_id = ? LIMIT 1").get(id)
    ) {
      throw new RoutingProfileError(
        409,
        "Detach this profile from the instance and tenants before deleting it."
      );
    }
    db.prepare("DELETE FROM routing_profiles WHERE id = ?").run(id);
  })();
  invalidateDbCache("settings");
}

export function getRoutingProfileBinding(tenantId?: string | null): ProfileBinding | null {
  const row = getDbInstance()
    .prepare("SELECT * FROM routing_profile_bindings WHERE scope = ?")
    .get(scopeFor(tenantId)) as Row | undefined;
  return row
    ? {
        profileId: String(row.profile_id),
        transparent: booleanValue(row.transparent_override),
        providerPriority: listValue(row.priority_override),
      }
    : null;
}

/** Switching a profile keeps explicit overrides; detaching restores the stored instance defaults. */
export function setRoutingProfileBinding(profileId: string | null, tenantId?: string | null): void {
  const db = getDbInstance();
  db.transaction(() => {
    if (profileId === null) {
      db.prepare("DELETE FROM routing_profile_bindings WHERE scope = ?").run(scopeFor(tenantId));
      return;
    }
    if (!getRoutingProfile(profileId))
      throw new RoutingProfileError(404, "Routing profile not found.");
    if (tenantId && !db.prepare("SELECT id FROM tenants WHERE id = ?").get(tenantId)) {
      throw new RoutingProfileError(404, "Tenant not found.");
    }
    db.prepare(
      `INSERT INTO routing_profile_bindings (scope, tenant_id, profile_id) VALUES (?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET profile_id = excluded.profile_id`
    ).run(scopeFor(tenantId), tenantId ?? null, profileId);
  })();
  invalidateDbCache("settings");
}

export function setInstanceProfileOverrides(patch: {
  transparent?: boolean | null;
  providerPriority?: string[] | null;
}): void {
  const current = getRoutingProfileBinding();
  if (!current)
    throw new RoutingProfileError(
      409,
      "Attach an instance profile before setting profile overrides."
    );
  const transparent = patch.transparent === undefined ? current.transparent : patch.transparent;
  const priority =
    patch.providerPriority === undefined ? current.providerPriority : patch.providerPriority;
  getDbInstance()
    .prepare(
      `UPDATE routing_profile_bindings SET transparent_override = ?, priority_override = ? WHERE scope = 'instance'`
    )
    .run(
      transparent === null ? null : transparent ? 1 : 0,
      priority === null ? null : JSON.stringify(priority)
    );
  invalidateDbCache("settings");
}
