"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { matchesSearch } from "@/shared/utils/turkishText";
import { Badge, Button, ConfirmModal, Input, Loading, Select } from "@/shared/components";
import {
  errorText,
  JSON_HEADERS,
  type TenantRow,
  type TenantUserRow,
} from "../tenants/tenantsTypes";

type User = TenantUserRow & {
  tenantName: string;
  tenantSlug: string;
  isOwner: boolean;
  lastLoginAt: string | null;
};
export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [tenant, setTenant] = useState("");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [newTenant, setNewTenant] = useState("");
  const [newRole, setNewRole] = useState("user");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [invite, setInvite] = useState<{ url: string; email: string; expiresAt: string } | null>(
    null
  );
  const [removing, setRemoving] = useState<User | null>(null);
  const load = useCallback(async () => {
    try {
      const [userRes, tenantRes] = await Promise.all([
        fetch("/api/access/users"),
        fetch("/api/tenants"),
      ]);
      const [userData, tenantData] = await Promise.all([userRes.json(), tenantRes.json()]);
      if (!userRes.ok) throw new Error(errorText(userData, "Unable to load users."));
      if (!tenantRes.ok) throw new Error(errorText(tenantData, "Unable to load tenants."));
      setUsers(userData.users);
      setTenants(tenantData.tenants);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to load users.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);
  const call = async (url: string, method: string, body?: unknown) => {
    setBusy(true);
    setError("");
    setNotice("");
    setInvite(null);
    try {
      const res = await fetch(url, {
        method,
        headers: JSON_HEADERS,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(data, "Unable to save changes."));
      await load();
      return data;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to save changes.");
      return null;
    } finally {
      setBusy(false);
    }
  };
  const inviteUser = async (user: User) => {
    const result = await call(`/api/tenants/${user.tenantId}/users/${user.id}/invite`, "POST");
    if (result)
      setInvite({
        email: user.email,
        expiresAt: result.expiresAt,
        url: `${window.location.origin}/login#tenant-invite=${encodeURIComponent(result.token)}`,
      });
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = await call(`/api/tenants/${newTenant}/users`, "POST", {
      email,
      displayName,
      role: newRole,
    });
    if (result) {
      setEmail("");
      setDisplayName("");
      setNotice("User created. Generate an invitation to let them set a password.");
    }
  };
  const visible = users.filter(
    (user) =>
      (!tenant || tenant === user.tenantId) &&
      (!roleFilter || (roleFilter === "owner" ? user.isOwner : user.role === roleFilter)) &&
      matchesSearch(`${user.email} ${user.displayName ?? ""} ${user.tenantName}`, search)
  );
  if (loading) return <Loading />;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-text-main">Users</h2>
        <p className="max-w-2xl text-xs text-text-muted">
          Manage tenant membership, invitations and sessions. The instance owner uses the instance
          sign-in and is separate from tenant accounts.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-xs text-feedback-danger-foreground">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-text-muted">
          {notice}
        </p>
      )}
      {invite && (
        <section
          className="flex flex-col gap-2 rounded-md border border-border p-3"
          aria-label="User invitation"
        >
          <p className="text-sm font-medium text-text-main">Invitation for {invite.email}</p>
          <Input
            label="Invitation link"
            value={invite.url}
            readOnly
            onFocus={(event) => event.target.select()}
          />
          <p className="text-xs text-text-muted">
            Share this link privately. It expires{" "}
            {new Date(invite.expiresAt).toLocaleString("en-US")} and works once. Generating another
            link replaces it.
          </p>
          <Button variant="ghost" size="sm" className="self-start" onClick={() => setInvite(null)}>
            Dismiss
          </Button>
        </section>
      )}
      <section className="flex flex-col gap-3" aria-label="Tenant users">
        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            label="Search users"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            placeholder=""
            label="Tenant"
            value={tenant}
            onChange={(event) => setTenant(event.target.value)}
            options={[
              { value: "", label: "All tenants" },
              ...tenants.map((row) => ({ value: row.id, label: row.name })),
            ]}
          />
          <Select
            placeholder=""
            label="Role"
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value)}
            options={[
              { value: "", label: "All roles" },
              { value: "owner", label: "Tenant owner" },
              { value: "admin", label: "Admin" },
              { value: "user", label: "User" },
            ]}
          />
        </div>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border text-text-muted">
                {["User", "Tenant", "Role", "Status", "Last sign-in", "Actions"].map((label) => (
                  <th key={label} className="px-3 py-2 font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((user) => (
                <tr key={user.id} className="border-b border-border last:border-0 text-text-main">
                  <td className="px-3 py-2">
                    <span className="font-medium">{user.email}</span>
                    {user.displayName && (
                      <span className="block text-text-muted">{user.displayName}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      className="underline underline-offset-4"
                      href={`/access/tenants?tenant=${encodeURIComponent(user.tenantId)}`}
                    >
                      {user.tenantName}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    {user.isOwner ? "Owner" : user.role === "admin" ? "Admin" : "User"}
                  </td>
                  <td className="px-3 py-2">
                    <Badge size="sm" variant={user.disabled ? "warning" : "success"}>
                      {user.disabled ? "Disabled" : "Active"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    {user.lastLoginAt
                      ? new Date(user.lastLoginAt).toLocaleString("en-US")
                      : "Never"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || user.disabled}
                        onClick={() => inviteUser(user)}
                      >
                        Invite
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || user.isOwner}
                        onClick={() =>
                          call(`/api/tenants/${user.tenantId}/users/${user.id}`, "PATCH", {
                            role: user.role === "admin" ? "user" : "admin",
                          })
                        }
                      >
                        {user.role === "admin" ? "Make user" : "Make admin"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || user.isOwner}
                        onClick={() =>
                          call(`/api/tenants/${user.tenantId}/users/${user.id}`, "PATCH", {
                            disabled: !user.disabled,
                          })
                        }
                      >
                        {user.disabled ? "Enable" : "Disable"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={async () => {
                          if (
                            await call(
                              `/api/tenants/${user.tenantId}/users/${user.id}/sessions`,
                              "DELETE"
                            )
                          )
                            setNotice(`Sessions revoked for ${user.email}.`);
                        }}
                      >
                        Sign out
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || user.isOwner}
                        onClick={() => setRemoving(user)}
                      >
                        Remove
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visible.length === 0 && (
          <p className="text-xs text-text-muted">
            No users match these filters. Add a user below or change the filters.
          </p>
        )}
        <p className="text-xs text-text-muted">
          Transfer ownership in the tenant profile before disabling, demoting or removing its owner.
        </p>
      </section>
      <section className="border-t border-border pt-6" aria-labelledby="new-user-title">
        <h3 id="new-user-title" className="mb-3 text-sm font-medium text-text-main">
          Add user
        </h3>
        <form
          onSubmit={create}
          className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_8rem_auto]"
        >
          <Select
            placeholder=""
            label="Tenant"
            value={newTenant}
            onChange={(event) => setNewTenant(event.target.value)}
            options={[
              { value: "", label: "Choose tenant" },
              ...tenants
                .filter((row) => !row.disabled)
                .map((row) => ({ value: row.id, label: row.name })),
            ]}
          />
          <Input
            label="Email"
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Input
            label="Display name"
            maxLength={80}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <Select
            placeholder=""
            label="Role"
            value={newRole}
            onChange={(event) => setNewRole(event.target.value)}
            options={[
              { value: "user", label: "User" },
              { value: "admin", label: "Admin" },
            ]}
          />
          <Button type="submit" loading={busy} disabled={!newTenant || !email.trim()}>
            Add user
          </Button>
        </form>
      </section>
      <ConfirmModal
        loading={busy}
        isOpen={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (
            removing &&
            (await call(`/api/tenants/${removing.tenantId}/users/${removing.id}`, "DELETE"))
          )
            setRemoving(null);
        }}
        title="Remove user"
        message={`Remove ${removing?.email ?? "this user"} from their tenant? Their sessions and invitations will stop working.`}
        confirmText="Remove user"
        variant="danger"
      />
    </div>
  );
}
