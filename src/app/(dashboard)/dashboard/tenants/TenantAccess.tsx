"use client";

import { useEffect, useState } from "react";
import { Button, Input, Loading, Select } from "@/shared/components";
import type { TenantProfile } from "@/lib/db/tenantProfiles";
import MonthlyUsageReport from "@/shared/components/MonthlyUsageReport";
import { errorText, JSON_HEADERS, type TenantUserRow } from "./tenantsTypes";

export default function TenantAccess({
  tenantId,
  users,
}: {
  tenantId: string;
  users: TenantUserRow[];
}) {
  const [profile, setProfile] = useState<TenantProfile | null>(null);
  const [fields, setFields] = useState<{ name: string; value: string }[]>([]);
  const [profileError, setProfileError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`/api/tenants/${tenantId}/profile`, { signal: abort.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(errorText(data, "Unable to load tenant profile."));
        setProfile(data.profile);
        setFields(
          Object.entries(data.profile.metadata).map(([name, value]) => ({
            name,
            value: String(value),
          }))
        );
      } catch (error) {
        if (!abort.signal.aborted)
          setProfileError(
            error instanceof Error ? error.message : "Unable to load tenant profile."
          );
      }
    })();
    return () => abort.abort();
  }, [tenantId]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!profile) return;
    const names = fields.map((field) => field.name.trim());
    if (names.some((name) => !name) || new Set(names).size !== names.length) {
      setProfileError("Metadata names must be unique and nonempty.");
      return;
    }
    setSaving(true);
    setProfileError("");
    setNotice("");
    try {
      const res = await fetch(`/api/tenants/${tenantId}/profile`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          ...profile,
          metadata: Object.fromEntries(fields.map((field) => [field.name.trim(), field.value])),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(data, "Unable to save tenant profile."));
      setProfile(data.profile);
      setNotice("Tenant profile saved.");
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Unable to save tenant profile.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section
        className="flex flex-col gap-3 border-t border-border pt-6"
        aria-labelledby="tenant-profile-title"
      >
        <h4 id="tenant-profile-title" className="text-sm font-medium text-text-main">
          Ownership and contacts
        </h4>
        <p className="max-w-2xl text-xs text-text-muted">
          Assign an active tenant admin as owner. Ownership stays within this tenant. Contact emails
          are for your records; invitations are shared manually.
        </p>
        {profileError && (
          <p role="alert" className="text-xs text-feedback-danger-foreground">
            {profileError}
          </p>
        )}
        {!profile && !profileError ? <Loading /> : null}
        {profile && (
          <form onSubmit={save} className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                placeholder=""
                label="Tenant owner"
                value={profile.ownerUserId ?? ""}
                onChange={(event) =>
                  setProfile({ ...profile, ownerUserId: event.target.value || null })
                }
                options={[
                  { value: "", label: "No owner assigned" },
                  ...users
                    .filter((user) => user.role === "admin" && !user.disabled)
                    .map((user) => ({ value: user.id, label: user.email })),
                ]}
              />
              <Input
                label="Owner contact email"
                type="email"
                maxLength={254}
                value={profile.ownerEmail}
                onChange={(event) => setProfile({ ...profile, ownerEmail: event.target.value })}
              />
              <Input
                label="Technical contact email"
                type="email"
                maxLength={254}
                value={profile.technicalEmail}
                onChange={(event) => setProfile({ ...profile, technicalEmail: event.target.value })}
              />
              <Input
                label="Billing contact email"
                type="email"
                maxLength={254}
                value={profile.billingEmail}
                onChange={(event) => setProfile({ ...profile, billingEmail: event.target.value })}
              />
            </div>
            <Input
              label="Description"
              maxLength={2000}
              value={profile.description}
              onChange={(event) => setProfile({ ...profile, description: event.target.value })}
            />
            <div className="flex flex-col gap-2">
              <h5 className="text-xs font-medium text-text-main">Metadata</h5>
              {fields.map((field, index) => (
                <div key={index} className="grid items-end gap-2 sm:grid-cols-[1fr_2fr_auto]">
                  <Input
                    label={`Field ${index + 1} name`}
                    maxLength={80}
                    required
                    value={field.name}
                    onChange={(event) =>
                      setFields(
                        fields.map((value, at) =>
                          at === index ? { ...value, name: event.target.value } : value
                        )
                      )
                    }
                  />
                  <Input
                    label={`Field ${index + 1} value`}
                    maxLength={500}
                    value={field.value}
                    onChange={(event) =>
                      setFields(
                        fields.map((value, at) =>
                          at === index ? { ...value, value: event.target.value } : value
                        )
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setFields(fields.filter((_, at) => at !== index))}
                    aria-label={`Remove metadata field ${index + 1}`}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                disabled={fields.length >= 20}
                onClick={() => setFields([...fields, { name: "", value: "" }])}
              >
                Add metadata field
              </Button>
            </div>
            <div className="flex items-center gap-3">
              <Button type="submit" loading={saving}>
                Save profile
              </Button>
              {notice && (
                <p role="status" className="text-xs text-text-muted">
                  {notice}
                </p>
              )}
            </div>
          </form>
        )}
      </section>
      <div className="border-t border-border pt-6">
        <MonthlyUsageReport tenantId={tenantId} />
      </div>
    </>
  );
}
