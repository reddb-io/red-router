---
"@reddb-io/red-router": minor
---

Tenant sign-in (backend). Tenant admins and users can now sign in with e-mail and password, through invitations the owner creates, and reach a small `/api/tenant/*` surface that shows only their own tenant.

- **Invitations.** `POST /api/tenants/:id/users/:userId/invite` returns a single-use, seven-day token; the person sets a password of at least 12 characters with `POST /api/auth/tenant/accept-invite`. A weak password does not spend the token.
- **A separate session.** The `rr_tenant` cookie is signed with its own derived key, carries no dashboard claim, and is re-checked against the database on every request: a disabled user or tenant, a role change, a password change or "sign out everywhere" (`DELETE /api/tenants/:id/users/:userId/sessions`) ends it at once.
- **Deny by default.** A new `TENANT` route class admits only a tenant session and only the routes listed in a manifest (`GET /api/tenant/me`, `/users` and `/keys` for now, the last two admin-only). No management page or API accepts a tenant session, and no management credential opens the tenant surface; a test walks every management route file to prove it.
- **Hardening.** Every failed sign-in returns the same answer, tenant sign-in has its own lockout bucket, it refuses to work when the dashboard has no login, and users with a second factor get the same TOTP step as the owner. Audit entries name the person as `tenant:<slug>/<e-mail>`.

There is no tenant dashboard yet; this release ships the sign-in and the API it will use.
