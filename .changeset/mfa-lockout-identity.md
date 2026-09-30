---
"@reddb-io/red-router": minor
---

Sign-in hardening.

- **Two-factor authentication** for the password login (Settings › Security): an authenticator app (TOTP, RFC 6238) plus ten one-time recovery codes. After the password, sign-in asks for the code; a correct password alone never opens a session. Codes cannot be replayed, and failed codes count against the same lockout as password failures. Lost the app and the codes? Run `red-router reset-password --disable-mfa` on the machine.
- **Lockouts persist and escalate.** A lockout decision now survives a restart, and repeated lockouts of the same client last 15 min, 30 min, 1 h, 6 h, then 24 h; a clean day resets the level.
- **Audit entries name a person.** Dashboard sessions carry who signed in (`owner`, `oidc:<e-mail>`, `saml:<e-mail>`), and audited actions on providers, keys sync, tenants and MFA are recorded under that identity, or `api-key:<id>` / `cli`, instead of a generic `admin`.
