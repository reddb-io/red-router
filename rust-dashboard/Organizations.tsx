import { useEffect, useState, type FormEvent } from "react";
import {
  deleteRustIdentityBinding,
  listRustIdentityBindings,
  listRustTenants,
  replaceRustIdentityBinding,
  replaceRustTenant,
  type RustIdentityBinding,
  type RustIdentityRole,
  type RustTenant,
} from "@/lib/rustControlPlane/browserClient";

type TenantDraft = { id: string; slug: string; name: string; enabled: boolean };
type BindingDraft = {
  id: string;
  issuer: string;
  oidcSubject: string;
  storedSubject: string;
  tenantId: string;
  role: RustIdentityRole;
  enabled: boolean;
};

const emptyTenant: TenantDraft = { id: "", slug: "", name: "", enabled: true };
const emptyBinding: BindingDraft = {
  id: "",
  issuer: "",
  oidcSubject: "",
  storedSubject: "",
  tenantId: "red",
  role: "tenant-admin",
  enabled: true,
};
const fieldClass = "w-full rounded border border-border bg-surface px-3 py-2 text-text-main";

function message(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

export default function Organizations() {
  const [tenants, setTenants] = useState<RustTenant[]>([]);
  const [bindings, setBindings] = useState<RustIdentityBinding[]>([]);
  const [tenantDraft, setTenantDraft] = useState<TenantDraft>(emptyTenant);
  const [bindingDraft, setBindingDraft] = useState<BindingDraft>(emptyBinding);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([listRustTenants(), listRustIdentityBindings()])
      .then(([nextTenants, nextBindings]) => {
        if (!active) return;
        setTenants(nextTenants);
        setBindings(nextBindings);
        if (nextTenants.length && !nextTenants.some((tenant) => tenant.id === "red")) {
          setBindingDraft((current) => ({ ...current, tenantId: nextTenants[0].id }));
        }
      })
      .catch((cause) => {
        if (active) setError(message(cause, "Could not load organizations."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function saveTenant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const tenant = await replaceRustTenant(tenantDraft.id.trim(), {
        slug: tenantDraft.slug.trim(),
        name: tenantDraft.name.trim(),
        enabled: tenantDraft.id.trim() === "red" ? true : tenantDraft.enabled,
      });
      setTenants((current) =>
        [...current.filter((item) => item.id !== tenant.id), tenant].sort((a, b) =>
          a.name.localeCompare(b.name)
        )
      );
      setTenantDraft(emptyTenant);
      setNotice(`Organization ${tenant.name} saved.`);
    } catch (cause) {
      setError(message(cause, "Could not save organization."));
    } finally {
      setBusy(false);
    }
  }

  async function saveBinding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const identity = bindingDraft.storedSubject
        ? { subject: bindingDraft.storedSubject }
        : {
            oidc_issuer: bindingDraft.issuer.trim(),
            oidc_subject: bindingDraft.oidcSubject.trim(),
          };
      const binding = await replaceRustIdentityBinding(bindingDraft.id.trim(), {
        ...identity,
        tenant_id: bindingDraft.tenantId,
        role: bindingDraft.role,
        enabled: bindingDraft.enabled,
      });
      setBindings((current) =>
        [...current.filter((item) => item.id !== binding.id), binding].sort((a, b) =>
          a.id.localeCompare(b.id)
        )
      );
      setBindingDraft({ ...emptyBinding, tenantId: tenants[0]?.id ?? "red" });
      setNotice(`Identity binding ${binding.id} saved.`);
    } catch (cause) {
      setError(message(cause, "Could not save identity binding."));
    } finally {
      setBusy(false);
    }
  }

  async function removeBinding(binding: RustIdentityBinding) {
    if (!window.confirm(`Delete identity binding ${binding.id}?`)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await deleteRustIdentityBinding(binding.id);
      setBindings((current) => current.filter((item) => item.id !== binding.id));
      if (bindingDraft.id === binding.id) setBindingDraft(emptyBinding);
      setNotice(`Identity binding ${binding.id} deleted.`);
    } catch (cause) {
      setError(message(cause, "Could not delete identity binding."));
    } finally {
      setBusy(false);
    }
  }

  const editingTenant = tenants.some((tenant) => tenant.id === tenantDraft.id);
  const editingBinding = Boolean(bindingDraft.storedSubject);

  return (
    <section className="mx-auto max-w-6xl space-y-8 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Organizations and identities</h1>
        <p className="mt-1 text-text-muted">
          Isolate provider connections, routing policies, API keys and usage by organization, then
          map verified OIDC identities to an administrative role.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {loading ? (
        <p>Loading…</p>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <form className="space-y-4 rounded border border-border p-4" onSubmit={saveTenant}>
              <h2 className="text-lg font-semibold">
                {editingTenant ? "Edit organization" : "Add organization"}
              </h2>
              <label className="block">
                Organization ID
                <input
                  className={fieldClass}
                  required
                  disabled={editingTenant}
                  value={tenantDraft.id}
                  onChange={(event) =>
                    setTenantDraft((current) => ({ ...current, id: event.target.value }))
                  }
                />
              </label>
              <label className="block">
                Slug
                <input
                  className={fieldClass}
                  required
                  value={tenantDraft.slug}
                  onChange={(event) =>
                    setTenantDraft((current) => ({ ...current, slug: event.target.value }))
                  }
                />
              </label>
              <label className="block">
                Name
                <input
                  className={fieldClass}
                  required
                  value={tenantDraft.name}
                  onChange={(event) =>
                    setTenantDraft((current) => ({ ...current, name: event.target.value }))
                  }
                />
              </label>
              <label className="block">
                <input
                  type="checkbox"
                  disabled={tenantDraft.id === "red"}
                  checked={tenantDraft.id === "red" || tenantDraft.enabled}
                  onChange={(event) =>
                    setTenantDraft((current) => ({ ...current, enabled: event.target.checked }))
                  }
                />{" "}
                Enabled
              </label>
              <div className="flex gap-3">
                <button type="submit" disabled={busy}>
                  Save organization
                </button>
                {editingTenant && (
                  <button type="button" disabled={busy} onClick={() => setTenantDraft(emptyTenant)}>
                    Cancel
                  </button>
                )}
              </div>
            </form>

            <form className="space-y-4 rounded border border-border p-4" onSubmit={saveBinding}>
              <h2 className="text-lg font-semibold">
                {editingBinding ? "Edit identity binding" : "Add identity binding"}
              </h2>
              <label className="block">
                Binding ID
                <input
                  className={fieldClass}
                  required
                  disabled={editingBinding}
                  value={bindingDraft.id}
                  onChange={(event) =>
                    setBindingDraft((current) => ({ ...current, id: event.target.value }))
                  }
                />
              </label>
              {editingBinding ? (
                <label className="block">
                  Canonical subject
                  <input className={fieldClass} readOnly value={bindingDraft.storedSubject} />
                </label>
              ) : (
                <>
                  <label className="block">
                    OIDC issuer
                    <input
                      className={fieldClass}
                      type="url"
                      required
                      value={bindingDraft.issuer}
                      onChange={(event) =>
                        setBindingDraft((current) => ({ ...current, issuer: event.target.value }))
                      }
                    />
                  </label>
                  <label className="block">
                    OIDC subject
                    <input
                      className={fieldClass}
                      required
                      value={bindingDraft.oidcSubject}
                      onChange={(event) =>
                        setBindingDraft((current) => ({
                          ...current,
                          oidcSubject: event.target.value,
                        }))
                      }
                    />
                  </label>
                </>
              )}
              <label className="block">
                Organization
                <select
                  className={fieldClass}
                  required
                  value={bindingDraft.tenantId}
                  onChange={(event) =>
                    setBindingDraft((current) => ({ ...current, tenantId: event.target.value }))
                  }
                >
                  {tenants
                    .filter((tenant) => tenant.enabled)
                    .map((tenant) => (
                      <option key={tenant.id} value={tenant.id}>
                        {tenant.name} ({tenant.id})
                      </option>
                    ))}
                </select>
              </label>
              <label className="block">
                Role
                <select
                  className={fieldClass}
                  value={bindingDraft.role}
                  onChange={(event) =>
                    setBindingDraft((current) => ({
                      ...current,
                      role: event.target.value as RustIdentityRole,
                    }))
                  }
                >
                  <option value="tenant-admin">Tenant administrator</option>
                  <option value="issuer">API-key issuer</option>
                  <option value="admin">Global administrator</option>
                </select>
              </label>
              <label className="block">
                <input
                  type="checkbox"
                  checked={bindingDraft.enabled}
                  onChange={(event) =>
                    setBindingDraft((current) => ({ ...current, enabled: event.target.checked }))
                  }
                />{" "}
                Enabled
              </label>
              <div className="flex gap-3">
                <button type="submit" disabled={busy || tenants.length === 0}>
                  Save identity binding
                </button>
                {editingBinding && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setBindingDraft(emptyBinding)}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          </div>

          <div className="space-y-3">
            <h2 className="text-lg font-semibold">Organizations</h2>
            {tenants.length === 0 ? (
              <p>No organizations configured.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr>
                      <th className="border-b border-border p-2">Name</th>
                      <th className="border-b border-border p-2">ID</th>
                      <th className="border-b border-border p-2">Slug</th>
                      <th className="border-b border-border p-2">Status</th>
                      <th className="border-b border-border p-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenants.map((tenant) => (
                      <tr key={tenant.id}>
                        <td className="border-b border-border p-2">{tenant.name}</td>
                        <td className="border-b border-border p-2">{tenant.id}</td>
                        <td className="border-b border-border p-2">{tenant.slug}</td>
                        <td className="border-b border-border p-2">
                          {tenant.enabled ? "Enabled" : "Disabled"}
                        </td>
                        <td className="border-b border-border p-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              setTenantDraft({
                                id: tenant.id,
                                slug: tenant.slug,
                                name: tenant.name,
                                enabled: tenant.enabled,
                              })
                            }
                          >
                            Edit
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <h2 className="text-lg font-semibold">OIDC identity bindings</h2>
            {bindings.length === 0 ? (
              <p>No identity bindings configured.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr>
                      <th className="border-b border-border p-2">ID</th>
                      <th className="border-b border-border p-2">Subject</th>
                      <th className="border-b border-border p-2">Organization</th>
                      <th className="border-b border-border p-2">Role</th>
                      <th className="border-b border-border p-2">Status</th>
                      <th className="border-b border-border p-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bindings.map((binding) => (
                      <tr key={binding.id}>
                        <td className="border-b border-border p-2">{binding.id}</td>
                        <td className="max-w-sm break-all border-b border-border p-2">
                          {binding.subject}
                        </td>
                        <td className="border-b border-border p-2">{binding.tenant_id}</td>
                        <td className="border-b border-border p-2">{binding.role}</td>
                        <td className="border-b border-border p-2">
                          {binding.enabled ? "Enabled" : "Disabled"}
                        </td>
                        <td className="border-b border-border p-2">
                          <div className="flex gap-3">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                setBindingDraft({
                                  id: binding.id,
                                  issuer: "",
                                  oidcSubject: "",
                                  storedSubject: binding.subject,
                                  tenantId: binding.tenant_id,
                                  role: binding.role,
                                  enabled: binding.enabled,
                                })
                              }
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void removeBinding(binding)}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
