"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Input, Loading, Modal } from "@/shared/components";
import TenantDetail from "./TenantDetail";
import { JSON_HEADERS, errorText, type TenantRow } from "./tenantsTypes";

/**
 * Tenants: an isolated slice of the instance (its own admins, users, API keys, accounts and combos).
 * The owner creates tenants here and assigns each one an admin; `red` is the default tenant.
 */
export default function TenantsPageClient() {
  const t = useTranslations("tenants");
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tenants");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(data, t("loadFailed")));
      setTenants(Array.isArray(data.tenants) ? data.tenants : []);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void (async () => {
      await load();
      setSelectedId(new URLSearchParams(window.location.search).get("tenant"));
    })();
  }, [load]);

  const create = async () => {
    setSaving(true);
    setCreateError("");
    try {
      const res = await fetch("/api/tenants", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ slug: slug.trim(), ...(name.trim() ? { name: name.trim() } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCreateError(errorText(data, t("saveFailed", { status: res.status })));
        return;
      }
      setCreateOpen(false);
      setSlug("");
      setName("");
      await load();
      setSelectedId(data.tenant?.id ?? null);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Unable to create tenant.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading />;
  const selected = tenants.find((tenant) => tenant.id === selectedId) ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold text-text-main">{t("title")}</h2>
          <p className="text-xs text-text-muted">{t("intro")}</p>
        </div>
        <Button icon="add" onClick={() => setCreateOpen(true)} className="shrink-0">
          {t("newTenant")}
        </Button>
      </div>

      {loadError ? (
        <p
          className="rounded-md border border-feedback-danger-border bg-feedback-danger-surface px-3 py-2 text-xs text-feedback-danger-foreground"
          role="alert"
        >
          {loadError}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-xs">
          <thead className="text-text-muted">
            <tr className="border-b border-border">
              <th className="px-3 py-2 font-medium">{t("colName")}</th>
              <th className="px-3 py-2 font-medium">{t("colAdmins")}</th>
              <th className="px-3 py-2 font-medium">{t("colUsers")}</th>
              <th className="px-3 py-2 font-medium">{t("colKeys")}</th>
              <th className="px-3 py-2 font-medium">{t("colConnections")}</th>
              <th className="px-3 py-2 font-medium">{t("colCombos")}</th>
              <th className="px-3 py-2 font-medium">{t("colStatus")}</th>
              <th className="px-3 py-2">
                <span className="sr-only">{t("manage")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((tenant) => (
              <tr
                key={tenant.id}
                className="border-b border-border align-middle last:border-0"
                aria-selected={tenant.id === selectedId}
              >
                <td className="px-3 py-2">
                  <div className="font-medium text-text-main">{tenant.name}</div>
                  <div className="flex items-center gap-1 text-text-muted">
                    <span>{tenant.slug}</span>
                    {tenant.isDefault ? (
                      <Badge size="sm" variant="outline">
                        {t("defaultBadge")}
                      </Badge>
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-2 tabular-nums text-text-main">
                  {tenant.isDefault ? t("ownerAdmin") : tenant.admins}
                </td>
                <td className="px-3 py-2 tabular-nums text-text-main">{tenant.users}</td>
                <td className="px-3 py-2 tabular-nums text-text-main">{tenant.apiKeys}</td>
                <td className="px-3 py-2 tabular-nums text-text-main">{tenant.connections}</td>
                <td className="px-3 py-2 tabular-nums text-text-main">{tenant.combos}</td>
                <td className="px-3 py-2">
                  <Badge size="sm" variant={tenant.disabled ? "warning" : "success"}>
                    {tenant.disabled ? t("statusDisabled") : t("statusActive")}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedId(tenant.id === selectedId ? null : tenant.id)}
                  >
                    {tenant.id === selectedId ? t("close") : t("manage")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected ? (
        <TenantDetail
          key={selected.id}
          tenant={selected}
          tenants={tenants}
          onChanged={load}
          onDeleted={() => {
            setSelectedId(null);
            void load();
          }}
        />
      ) : null}

      <Modal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t("createTitle")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={create} loading={saving} disabled={slug.trim().length < 2}>
              {t("create")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Input
            label={t("fieldSlug")}
            value={slug}
            onChange={(event) => setSlug(event.target.value.toLowerCase())}
            hint={t("fieldSlugHint")}
            maxLength={32}
          />
          <Input
            label={t("fieldName")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("namePlaceholder")}
            maxLength={80}
          />
          {createError ? (
            <p className="text-xs text-feedback-danger-foreground" role="alert">
              {createError}
            </p>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
