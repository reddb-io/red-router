import Link from "next/link";

const roles = [
  [
    "Instance owner",
    "Entire instance",
    "Creates tenants, manages all users and resources, assigns tenant owners, locks routing policy and reviews usage. Uses the instance sign-in.",
  ],
  [
    "Tenant owner",
    "One tenant",
    "An active tenant admin designated as the responsible person. Has the same session permissions as a tenant admin. Ownership must be transferred before removal, disabling or demotion.",
  ],
  [
    "Admin",
    "One tenant",
    "Reads their tenant's users and masked API keys, and changes tenant routing where instance policy allows it. Cannot create tenants or manage other tenants.",
  ],
  [
    "User",
    "One tenant",
    "Reads their identity and available tenant capabilities. Model traffic requires an API key with its own scopes and routing limits.",
  ],
];
export default function RolesPage() {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold text-text-main">Roles</h2>
        <p className="max-w-2xl text-xs text-text-muted">
          Tenant membership and API key permissions are separate. An admin or tenant owner never
          inherits instance management access.
        </p>
      </div>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-text-muted">
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Scope</th>
              <th className="px-4 py-3 font-medium">Permissions</th>
            </tr>
          </thead>
          <tbody>
            {roles.map(([name, scope, description]) => (
              <tr key={name} className="border-b border-border align-top last:border-0">
                <th className="px-4 py-3 font-medium text-text-main">{name}</th>
                <td className="px-4 py-3 text-text-main">{scope}</td>
                <td className="max-w-2xl px-4 py-3 text-text-muted">{description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-text-muted">
        Role or status changes invalidate existing tenant sessions. Scoped management tokens are
        instance credentials and cannot be assigned to tenant API keys.
      </p>
      <div className="flex gap-4 text-sm">
        <Link className="text-text-main underline underline-offset-4" href="/access/users">
          Manage users
        </Link>
        <Link className="text-text-main underline underline-offset-4" href="/access/tenants">
          Assign tenant ownership
        </Link>
      </div>
    </div>
  );
}
