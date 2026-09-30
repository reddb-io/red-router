"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Card, ConfirmModal, Input, Loading, Select } from "@/shared/components";
import TenantAccess from "./TenantAccess";
import {
  JSON_HEADERS,
  errorText,
  type ResourceLists,
  type ResourceRow,
  type TenantRow,
  type TenantUserRow,
} from "./tenantsTypes";

interface Props {
  tenant: TenantRow;
  tenants: TenantRow[];
  onChanged: () => void | Promise<void>;
  onDeleted: () => void;
}

type Kind = "apiKeys" | "connections" | "combos";
const KINDS: Kind[] = ["apiKeys", "connections", "combos"];
const KIND_LABEL: Record<Kind, string> = {
  apiKeys: "kindApiKeys",
  connections: "kindConnections",
  combos: "kindCombos",
};

/** One tenant: its people (admin and users), scoped API keys and the resources it owns. */
export default function TenantDetail({ tenant, tenants, onChanged, onDeleted }: Props) {
  const t = useTranslations("tenants");
  const [users, setUsers] = useState<TenantUserRow[] | null>(null);
  const [resources, setResources] = useState<ResourceLists | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "user">("admin");
  const [keyName, setKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const tenantName = (id: string) => tenants.find((row) => row.id === id)?.name ?? id;

  const loadAll = useCallback(async () => {
    try {
      const [usersRes, resourcesRes] = await Promise.all([
        fetch(`/api/tenants/${tenant.id}/users`),
        fetch("/api/tenants/resources"),
      ]);
      const usersData = await usersRes.json().catch(() => ({}));
      const resourcesData = await resourcesRes.json().catch(() => ({}));
      if (!usersRes.ok) throw new Error(errorText(usersData, "Unable to load tenant users."));
      if (!resourcesRes.ok)
        throw new Error(errorText(resourcesData, "Unable to load tenant resources."));
      setUsers(Array.isArray(usersData.users) ? usersData.users : []);
      setResources(
        resourcesData && Array.isArray(resourcesData.connections)
          ? (resourcesData as ResourceLists)
          : { connections: [], combos: [], apiKeys: [] }
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to load tenant details.");
    }
  }, [tenant.id]);

  useEffect(() => {
    void (async () => {
      await loadAll();
    })();
  }, [loadAll]);

  const call = async (
    url: string,
    method: string,
    body?: unknown,
    okNotice?: string
  ): Promise<Record<string, unknown> | null> => {
    setNotice(null);
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        headers: JSON_HEADERS,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice(errorText(data, t("saveFailed", { status: res.status })));
        return null;
      }
      if (okNotice) setNotice(okNotice);
      return data as Record<string, unknown>;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to save changes.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    await Promise.all([loadAll(), onChanged()]);
  };

  const addUser = async () => {
    const done = await call(`/api/tenants/${tenant.id}/users`, "POST", { email, role });
    if (done) {
      setEmail("");
      await refresh();
    }
  };

  const changeRole = async (user: TenantUserRow) => {
    const done = await call(`/api/tenants/${tenant.id}/users/${user.id}`, "PATCH", {
      role: user.role === "admin" ? "user" : "admin",
    });
    if (done) await refresh();
  };

  const removeUser = async (user: TenantUserRow) => {
    const done = await call(`/api/tenants/${tenant.id}/users/${user.id}`, "DELETE");
    if (done) await refresh();
  };

  const createKey = async () => {
    const done = await call("/api/keys", "POST", { name: keyName.trim(), tenantId: tenant.id });
    if (done) {
      setCreatedKey(typeof done.key === "string" ? done.key : null);
      setKeyName("");
      await refresh();
    }
  };

  const toggleDisabled = async () => {
    const done = await call(`/api/tenants/${tenant.id}`, "PATCH", { disabled: !tenant.disabled });
    if (done) await refresh();
  };

  const remove = async () => {
    const done = await call(`/api/tenants/${tenant.id}`, "DELETE");
    setConfirmDelete(false);
    if (done) onDeleted();
  };

  const move = async () => {
    const chosen = (kind: Kind) =>
      (resources?.[kind] ?? []).filter((row) => picked[`${kind}:${row.id}`]).map((row) => row.id);
    const payload = {
      apiKeyIds: chosen("apiKeys"),
      connectionIds: chosen("connections"),
      comboIds: chosen("combos"),
    };
    const count = payload.apiKeyIds.length + payload.connectionIds.length + payload.comboIds.length;
    if (count === 0) {
      setNotice(t("nothingToMove"));
      return;
    }
    const done = await call(
      `/api/tenants/${tenant.id}/resources`,
      "POST",
      payload,
      t("moved", { count })
    );
    if (done) {
      setPicked({});
      await refresh();
    }
  };

  const share = async (kind: "connection" | "combo", row: ResourceRow) => {
    const done = await call(`/api/tenants/${tenant.id}/shared`, "PUT", {
      kind,
      id: row.id,
      shared: !row.shared,
    });
    if (done) await refresh();
  };

  if (!users || !resources)
    return notice ? (
      <p role="alert" className="text-xs text-feedback-danger-foreground">
        {notice}
      </p>
    ) : (
      <Loading />
    );

  return (
    <Card>
      <div className="flex flex-col gap-6 p-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-text-main">{tenant.name}</h3>
            <p className="text-xs text-text-muted">{tenant.slug}</p>
          </div>
          {tenant.isDefault ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-text-muted">{t("disableHint")}</span>
              <Button variant="outline" size="sm" onClick={toggleDisabled} disabled={busy}>
                {tenant.disabled ? t("enableTenant") : t("disableTenant")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon="delete"
                onClick={() => setConfirmDelete(true)}
              >
                {t("deleteTenant")}
              </Button>
            </div>
          )}
        </div>

        {notice ? (
          <p
            className="rounded-md border border-border px-3 py-2 text-xs text-text-main"
            role="status"
          >
            {notice}
          </p>
        ) : null}

        <TenantAccess tenantId={tenant.id} users={users} />

        <section className="flex flex-col gap-3">
          <div>
            <h4 className="text-sm font-medium text-text-main">{t("peopleTitle")}</h4>
            <p className="text-xs text-text-muted">{t("peopleHint")}</p>
            {tenant.isDefault ? (
              <p className="mt-1 text-xs text-text-muted">{t("ownerNote")}</p>
            ) : null}
          </div>
          {users.length === 0 ? (
            <p className="text-xs text-text-muted">{t("noUsers")}</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border text-xs">
              {users.map((user) => (
                <li key={user.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-text-main">{user.email}</span>
                  <Badge size="sm" variant={user.role === "admin" ? "primary" : "outline"}>
                    {user.role === "admin" ? t("roleAdmin") : t("roleUser")}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => changeRole(user)}
                    disabled={busy}
                  >
                    {user.role === "admin" ? t("makeUser") : t("makeAdmin")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeUser(user)}
                    disabled={busy}
                  >
                    {t("removeUser")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_10rem_auto]">
            <Input
              label={t("fieldEmail")}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Select
              label={t("fieldRole")}
              value={role}
              onChange={(event) => setRole(event.target.value === "user" ? "user" : "admin")}
              options={[
                { value: "admin", label: t("roleAdmin") },
                { value: "user", label: t("roleUser") },
              ]}
            />
            <Button onClick={addUser} disabled={busy || !email.trim()}>
              {t("addUser")}
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div>
            <h4 className="text-sm font-medium text-text-main">{t("keysTitle")}</h4>
            <p className="text-xs text-text-muted">{t("keysHint")}</p>
          </div>
          <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_auto]">
            <Input
              label={t("keyName")}
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
              maxLength={200}
            />
            <Button onClick={createKey} disabled={busy || !keyName.trim()}>
              {t("newKey")}
            </Button>
          </div>
          {createdKey ? (
            <div className="rounded-md border border-feedback-warning-border bg-feedback-warning-surface px-3 py-2 text-xs text-feedback-warning-foreground">
              <p className="mb-1">{t("keyCreated")}</p>
              <code className="break-all">{createdKey}</code>
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-3">
          <div>
            <h4 className="text-sm font-medium text-text-main">{t("resourcesTitle")}</h4>
            <p className="text-xs text-text-muted">{t("resourcesHint")}</p>
          </div>
          {KINDS.map((kind) => {
            const rows = resources[kind];
            const owned = rows.filter((row) => row.tenantId === tenant.id);
            const others = rows.filter((row) => row.tenantId !== tenant.id);
            const shareKind =
              kind === "connections" ? "connection" : kind === "combos" ? "combo" : null;
            return (
              <div key={kind} className="flex flex-col gap-2">
                <span className="text-xs font-medium text-text-main">{t(KIND_LABEL[kind])}</span>
                {owned.length === 0 ? (
                  <p className="text-xs text-text-muted">{t("noResources")}</p>
                ) : (
                  <ul className="divide-y divide-border rounded-md border border-border text-xs">
                    {owned.map((row) => (
                      <li key={row.id} className="flex items-center gap-2 px-3 py-2">
                        <span className="min-w-0 flex-1 truncate text-text-main">{row.name}</span>
                        {row.detail ? <span className="text-text-muted">{row.detail}</span> : null}
                        {row.shared ? (
                          <Badge size="sm" variant="info">
                            {t("sharedBadge")}
                          </Badge>
                        ) : null}
                        {shareKind ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => share(shareKind, row)}
                          >
                            {row.shared ? t("unshare") : t("share")}
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                {others.length > 0 ? (
                  <ul className="max-h-40 divide-y divide-border overflow-y-auto rounded-md border border-border text-xs">
                    {others.map((row) => (
                      <li key={row.id} className="flex items-center gap-2 px-3 py-1.5">
                        <input
                          type="checkbox"
                          id={`move-${kind}-${row.id}`}
                          checked={picked[`${kind}:${row.id}`] === true}
                          onChange={(event) =>
                            setPicked({ ...picked, [`${kind}:${row.id}`]: event.target.checked })
                          }
                        />
                        <label
                          htmlFor={`move-${kind}-${row.id}`}
                          className="min-w-0 flex-1 truncate text-text-main"
                        >
                          {row.name}
                        </label>
                        <span className="text-text-muted">
                          {t("ownedBy", { tenant: tenantName(row.tenantId) })}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
          <div>
            <Button variant="outline" onClick={move} disabled={busy}>
              {t("moveHere")}
            </Button>
          </div>
        </section>
      </div>

      <ConfirmModal
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        title={t("deleteTitle")}
        message={t("deleteBody")}
        confirmText={t("deleteTenant")}
        cancelText={t("cancel")}
        variant="danger"
        loading={busy}
      />
    </Card>
  );
}
