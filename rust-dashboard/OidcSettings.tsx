import { useEffect, useState, type FormEvent } from "react";
import { rustAdminFetch } from "./api/browserClient";

type Browser = {
  public_origin: string;
  client_id: string;
  authorization_endpoint: string;
  token_endpoint: string;
  scopes: string[];
  has_client_secret: boolean;
};
type Oidc = {
  enabled: boolean;
  issuer: string;
  audience: string;
  jwks_uri: string;
  required_claims: Record<string, string[]>;
  allowed_subjects: string[];
  browser?: Browser;
};
type Draft = {
  enabled: boolean;
  issuer: string;
  audience: string;
  jwks: string;
  origin: string;
  client: string;
  secret: string;
  authorization: string;
  token: string;
  scopes: string;
  subjects: string;
  claims: string;
};

const empty: Draft = {
  enabled: true,
  issuer: "",
  audience: "",
  jwks: "",
  origin: "",
  client: "",
  secret: "",
  authorization: "",
  token: "",
  scopes: "openid profile email",
  subjects: "",
  claims: "{}",
};
const fieldClass = "w-full rounded border border-border bg-surface px-3 py-2 text-text-main";

async function request(path: string, init?: RequestInit) {
  const response = await rustAdminFetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
  return body;
}

export default function OidcSettings() {
  const [draft, setDraft] = useState<Draft>(empty);
  const [secretSaved, setSecretSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const update = (values: Partial<Draft>) => setDraft((current) => ({ ...current, ...values }));

  useEffect(() => {
    let active = true;
    request("/api/admin/oidc")
      .then(({ oidc }: { oidc: Oidc | null }) => {
        if (!active) return;
        setLoaded(true);
        if (!oidc) {
          update({ origin: window.location.origin });
          return;
        }
        const browser = oidc.browser;
        setSecretSaved(browser?.has_client_secret === true);
        setDraft({
          enabled: oidc.enabled,
          issuer: oidc.issuer,
          audience: oidc.audience,
          jwks: oidc.jwks_uri,
          origin: browser?.public_origin ?? window.location.origin,
          client: browser?.client_id ?? "",
          secret: "",
          authorization: browser?.authorization_endpoint ?? "",
          token: browser?.token_endpoint ?? "",
          scopes: browser?.scopes.join(" ") ?? "openid profile email",
          subjects: oidc.allowed_subjects.join("\n"),
          claims: JSON.stringify(oidc.required_claims, null, 2),
        });
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load settings.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function discover() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { discovery } = await request("/api/admin/oidc/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issuer: draft.issuer.trim() }),
      });
      update({
        issuer: discovery.issuer,
        jwks: discovery.jwks_uri,
        authorization: discovery.authorization_endpoint,
        token: discovery.token_endpoint,
      });
      setNotice("Issuer metadata loaded. Review the fields before saving.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Discovery failed.");
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const claims: unknown = JSON.parse(draft.claims);
      if (
        !claims ||
        typeof claims !== "object" ||
        Array.isArray(claims) ||
        Object.values(claims).some(
          (value) =>
            !Array.isArray(value) ||
            value.length === 0 ||
            value.some((item) => typeof item !== "string" || !item.trim())
        )
      ) {
        throw new Error("Required claims must be a JSON object of nonempty arrays of strings.");
      }
      const { oidc } = await request("/api/admin/oidc", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: draft.enabled,
          issuer: draft.issuer.trim(),
          audience: draft.audience.trim() || draft.client.trim(),
          jwks_uri: draft.jwks.trim(),
          required_claims: claims,
          allowed_subjects: draft.subjects
            .split("\n")
            .map((v) => v.trim())
            .filter(Boolean),
          browser: {
            public_origin: draft.origin.trim(),
            client_id: draft.client.trim(),
            ...(draft.secret ? { client_secret: draft.secret } : {}),
            authorization_endpoint: draft.authorization.trim(),
            token_endpoint: draft.token.trim(),
            scopes: draft.scopes.split(/\s+/).filter(Boolean),
          },
        }),
      });
      setSecretSaved(oidc?.browser?.has_client_secret === true);
      update({ secret: "" });
      setNotice("Saved. Sign in again to activate the new policy revision.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save settings.");
    } finally {
      setBusy(false);
    }
  }

  const field = (label: string, name: keyof Draft, type = "text") => (
    <label className="block">
      {label}
      <input
        className={fieldClass}
        type={type}
        value={String(draft[name])}
        onChange={(event) => update({ [name]: event.target.value })}
      />
    </label>
  );
  return (
    <section className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Single sign-on</h1>
      <p>
        Configure the OpenID Connect identity provider for the Rust dashboard and control plane.
      </p>
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {loading ? (
        <p>Loading…</p>
      ) : (
        loaded && (
          <form onSubmit={(event) => void save(event)} className="space-y-4">
            <label className="block">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => update({ enabled: event.target.checked })}
              />{" "}
              Enable OIDC
            </label>
            {field("Issuer URL", "issuer", "url")}
            <button
              type="button"
              disabled={busy || !draft.issuer.trim()}
              onClick={() => void discover()}
            >
              Discover endpoints
            </button>
            {field("Audience", "audience")}
            {field("JWKS URL", "jwks", "url")}
            {field("Public dashboard origin", "origin", "url")}
            {field("Client ID", "client")}
            {field(
              secretSaved ? "Client secret (leave blank to keep existing)" : "Client secret",
              "secret",
              "password"
            )}
            {field("Authorization endpoint", "authorization", "url")}
            {field("Token endpoint", "token", "url")}
            {field("Scopes (space separated)", "scopes")}
            <label className="block">
              Allowed subjects (one per line)
              <textarea
                className={fieldClass}
                value={draft.subjects}
                onChange={(event) => update({ subjects: event.target.value })}
              />
            </label>
            <label className="block">
              Required claims (JSON)
              <textarea
                className={fieldClass}
                value={draft.claims}
                onChange={(event) => update({ claims: event.target.value })}
              />
            </label>
            <button type="submit" disabled={busy}>
              Save OIDC settings
            </button>
          </form>
        )
      )}
    </section>
  );
}
