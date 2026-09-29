---
"@reddb-io/red-router": minor
---

SAML 2.0 sign-in for the dashboard (Settings → Security → SAML, "Continue with SAML" on the login page), ported from 9router with its gaps closed. A response is accepted only if it answers an AuthnRequest this server sent (the request id lives in a single-use, expiring server-side store, so IdP-initiated and replayed responses fail), the assertion must be signed with the configured certificate and addressed to our entity ID, only e-mails on your allow list are let in (9router opens the dashboard to anyone the identity provider signs in), and every failure redirects with a fixed code instead of echoing the error. There is a static setup check, a real test sign-in that opens no session, and the service-provider metadata to register at the identity provider. Password login always stays available next to SAML, and `red-router reset-password --disable-sso` also switches SAML off.
