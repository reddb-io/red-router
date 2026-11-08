//! Signed OIDC bearer authentication for the Rust management API.
use crate::storage::StoredOidcConfig;
use futures_util::StreamExt;
use jsonwebtoken::{
    decode, decode_header,
    jwk::{AlgorithmParameters, Jwk, JwkSet, KeyOperations, PublicKeyUse},
    Algorithm, DecodingKey, Validation,
};
use serde_json::Value;
use std::{collections::BTreeMap, net::IpAddr, time::Duration};
use tokio::sync::Mutex;

const MAX_JWKS_BYTES: usize = 1024 * 1024;
const MAX_TOKEN_BYTES: usize = 16 * 1024;
const JWKS_TTL: Duration = Duration::from_secs(300);
const JWKS_REFRESH_COOLDOWN: Duration = Duration::from_secs(30);

#[derive(Clone, Debug)]
pub(crate) struct OidcPolicy {
    pub(crate) enabled: bool,
    pub(crate) issuer: String,
    pub(crate) audience: String,
    pub(crate) jwks_uri: reqwest::Url,
    pub(crate) required_claims: BTreeMap<String, Vec<String>>,
    pub(crate) allowed_subjects: Vec<String>,
    pub(crate) revision: i64,
}

struct CachedKeys {
    loaded_at: tokio::time::Instant,
    keys: JwkSet,
}

pub(crate) struct OidcVerifier {
    policy: OidcPolicy,
    allow_private: bool,
    cache: Mutex<Option<CachedKeys>>,
}

impl OidcVerifier {
    pub(crate) fn from_stored(
        stored: &StoredOidcConfig,
        allow_private: bool,
    ) -> Result<Self, &'static str> {
        let required_claims: BTreeMap<String, Vec<String>> =
            serde_json::from_str(&stored.required_claims_json)
                .map_err(|_| "invalid OIDC claim policy")?;
        validate_claim_policy(&required_claims)?;
        let allowed_subjects: Vec<String> = serde_json::from_str(&stored.allowed_subjects_json)
            .map_err(|_| "invalid OIDC subject policy")?;
        validate_subjects(&allowed_subjects)?;
        if stored.enabled && required_claims.is_empty() && allowed_subjects.is_empty() {
            return Err("enabled OIDC requires an access policy");
        }
        if stored.issuer.is_empty()
            || stored.issuer.len() > 2048
            || stored.issuer.trim() != stored.issuer
            || stored.audience.is_empty()
            || stored.audience.len() > 200
            || stored.audience.trim() != stored.audience
            || stored.jwks_uri.trim() != stored.jwks_uri
            || stored.revision < 0
        {
            return Err("invalid OIDC configuration");
        }
        validate_issuer(&stored.issuer)?;
        let jwks_uri = validate_endpoint(&stored.jwks_uri)?;
        Ok(Self {
            policy: OidcPolicy {
                enabled: stored.enabled,
                issuer: stored.issuer.clone(),
                audience: stored.audience.clone(),
                jwks_uri,
                required_claims,
                allowed_subjects,
                revision: stored.revision,
            },
            allow_private,
            cache: Mutex::new(None),
        })
    }

    pub(crate) fn policy(&self) -> &OidcPolicy {
        &self.policy
    }

    pub(crate) async fn prime(&self) -> Result<(), &'static str> {
        if self.policy.enabled {
            self.keys(true).await?;
        }
        Ok(())
    }

    pub(crate) async fn verify(&self, token: &str) -> Result<String, &'static str> {
        if !self.policy.enabled || token.is_empty() || token.len() > MAX_TOKEN_BYTES {
            return Err("invalid OIDC token");
        }
        let header = decode_header(token).map_err(|_| "invalid OIDC token")?;
        if !safe_algorithm(header.alg) {
            return Err("invalid OIDC token algorithm");
        }
        let kid = header
            .kid
            .as_deref()
            .filter(|kid| !kid.is_empty() && kid.len() <= 256)
            .ok_or("OIDC token key ID is missing")?;
        let mut keys = self.keys(false).await?;
        let mut key = keys.find(kid).cloned();
        if key.is_none() {
            keys = self.keys(true).await?;
            key = keys.find(kid).cloned();
        }
        let key = key.ok_or("OIDC token key is unavailable")?;
        if key
            .common
            .public_key_use
            .as_ref()
            .is_some_and(|usage| usage != &PublicKeyUse::Signature)
            || key
                .common
                .key_operations
                .as_ref()
                .is_some_and(|operations| {
                    !operations
                        .iter()
                        .any(|operation| operation == &KeyOperations::Verify)
                })
            || key
                .common
                .key_algorithm
                .is_some_and(|algorithm| algorithm.to_string() != algorithm_name(header.alg))
        {
            return Err("OIDC token key is not valid for verification");
        }
        let key = DecodingKey::from_jwk(&key).map_err(|_| "invalid OIDC verification key")?;
        let mut validation = Validation::new(header.alg);
        validation.set_audience(&[&self.policy.audience]);
        let issuers = accepted_issuers(&self.policy.issuer);
        validation.set_issuer(&issuers);
        validation.set_required_spec_claims(&["exp", "iss", "aud"]);
        validation.validate_nbf = true;
        let token = decode::<Value>(token, &key, &validation).map_err(|_| "invalid OIDC token")?;
        let claims = token.claims.as_object().ok_or("invalid OIDC claims")?;
        if !matches_claims(&self.policy.required_claims, claims) {
            return Err("OIDC claims are not allowed");
        }
        let subject = claims.get("sub").and_then(Value::as_str).unwrap_or("");
        let email = if claims.get("email_verified") == Some(&Value::Bool(true)) {
            claims
                .get("email")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase()
        } else {
            String::new()
        };
        if !self.policy.allowed_subjects.is_empty()
            && !self.policy.allowed_subjects.iter().any(|allowed| {
                allowed == subject || (!email.is_empty() && allowed.to_ascii_lowercase() == email)
            })
        {
            return Err("OIDC subject is not allowed");
        }
        if subject.is_empty() && email.is_empty() {
            return Err("OIDC subject is missing");
        }
        Ok(format!(
            "oidc:{}",
            if email.is_empty() { subject } else { &email }
        ))
    }

    async fn keys(&self, force: bool) -> Result<JwkSet, &'static str> {
        let mut cache = self.cache.lock().await;
        if let Some(cached) = cache.as_ref() {
            let age = cached.loaded_at.elapsed();
            if (!force && age < JWKS_TTL) || (force && age < JWKS_REFRESH_COOLDOWN) {
                return Ok(cached.keys.clone());
            }
        }
        let client = pinned_client(&self.policy.jwks_uri, self.allow_private).await?;
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            client.get(self.policy.jwks_uri.clone()).send(),
        )
        .await
        .map_err(|_| "OIDC JWKS request timed out")?
        .map_err(|_| "OIDC JWKS request failed")?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|length| length > MAX_JWKS_BYTES as u64)
        {
            return Err("OIDC JWKS response is unavailable");
        }
        let bytes = tokio::time::timeout(Duration::from_secs(5), async move {
            let mut body = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| "OIDC JWKS response is invalid")?;
                if body
                    .len()
                    .checked_add(chunk.len())
                    .is_none_or(|length| length > MAX_JWKS_BYTES)
                {
                    return Err("OIDC JWKS response is too large");
                }
                body.extend_from_slice(&chunk);
            }
            Ok::<_, &'static str>(body)
        })
        .await
        .map_err(|_| "OIDC JWKS response timed out")??;
        let keys: JwkSet =
            serde_json::from_slice(&bytes).map_err(|_| "OIDC JWKS response is invalid")?;
        if keys.keys.is_empty() || keys.keys.len() > 64 {
            return Err("OIDC JWKS key count is invalid");
        }
        if !keys.keys.iter().any(usable_verification_key) {
            return Err("OIDC JWKS has no usable verification key");
        }
        *cache = Some(CachedKeys {
            loaded_at: tokio::time::Instant::now(),
            keys: keys.clone(),
        });
        Ok(keys)
    }
}

fn usable_verification_key(key: &Jwk) -> bool {
    !matches!(key.algorithm, AlgorithmParameters::OctetKey(_))
        && key
            .common
            .public_key_use
            .as_ref()
            .is_none_or(|usage| usage == &PublicKeyUse::Signature)
        && key.common.key_operations.as_ref().is_none_or(|operations| {
            operations
                .iter()
                .any(|operation| operation == &KeyOperations::Verify)
        })
        && key.common.key_algorithm.is_none_or(|algorithm| {
            matches!(
                algorithm.to_string().as_str(),
                "RS256"
                    | "RS384"
                    | "RS512"
                    | "PS256"
                    | "PS384"
                    | "PS512"
                    | "ES256"
                    | "ES384"
                    | "EdDSA"
            )
        })
        && DecodingKey::from_jwk(key).is_ok()
}

pub(crate) fn validate_claim_policy(
    claims: &BTreeMap<String, Vec<String>>,
) -> Result<(), &'static str> {
    if claims.len() > 16 {
        return Err("invalid OIDC claim policy");
    }
    for (name, allowed) in claims {
        let mut chars = name.chars();
        if name.len() > 64
            || !chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
            || matches!(name.as_str(), "constructor" | "prototype" | "__proto__")
            || allowed.is_empty()
            || allowed.len() > 16
            || allowed
                .iter()
                .any(|value| value.trim().is_empty() || value.len() > 200)
        {
            return Err("invalid OIDC claim policy");
        }
    }
    Ok(())
}

pub(crate) fn validate_subjects(subjects: &[String]) -> Result<(), &'static str> {
    if subjects.len() > 256
        || subjects
            .iter()
            .any(|subject| subject.trim().is_empty() || subject.len() > 200)
    {
        return Err("invalid OIDC subject policy");
    }
    Ok(())
}

fn matches_claims(
    policy: &BTreeMap<String, Vec<String>>,
    claims: &serde_json::Map<String, Value>,
) -> bool {
    policy.iter().all(|(name, allowed)| match claims.get(name) {
        Some(Value::String(value)) => allowed.contains(value),
        Some(Value::Array(values)) => values.iter().any(|value| {
            value
                .as_str()
                .is_some_and(|value| allowed.iter().any(|v| v == value))
        }),
        _ => false,
    })
}

fn accepted_issuers(issuer: &str) -> Vec<String> {
    let trimmed = issuer.trim_end_matches('/');
    let mut issuers = vec![issuer.to_owned()];
    let alternate = if issuer.ends_with('/') {
        trimmed.to_owned()
    } else {
        format!("{issuer}/")
    };
    if alternate != issuer {
        issuers.push(alternate);
    }
    issuers
}

fn safe_algorithm(algorithm: Algorithm) -> bool {
    matches!(
        algorithm,
        Algorithm::RS256
            | Algorithm::RS384
            | Algorithm::RS512
            | Algorithm::PS256
            | Algorithm::PS384
            | Algorithm::PS512
            | Algorithm::ES256
            | Algorithm::ES384
            | Algorithm::EdDSA
    )
}

fn algorithm_name(algorithm: Algorithm) -> &'static str {
    match algorithm {
        Algorithm::RS256 => "RS256",
        Algorithm::RS384 => "RS384",
        Algorithm::RS512 => "RS512",
        Algorithm::PS256 => "PS256",
        Algorithm::PS384 => "PS384",
        Algorithm::PS512 => "PS512",
        Algorithm::ES256 => "ES256",
        Algorithm::ES384 => "ES384",
        Algorithm::EdDSA => "EdDSA",
        Algorithm::HS256 => "HS256",
        Algorithm::HS384 => "HS384",
        Algorithm::HS512 => "HS512",
    }
}

fn validate_issuer(raw: &str) -> Result<(), &'static str> {
    let issuer = reqwest::Url::parse(raw).map_err(|_| "invalid OIDC issuer")?;
    if issuer.scheme() != "https"
        || issuer.host_str().is_none()
        || !issuer.username().is_empty()
        || issuer.password().is_some()
        || issuer.query().is_some()
        || issuer.fragment().is_some()
    {
        return Err("OIDC issuer must be a credential-free HTTPS URL");
    }
    Ok(())
}

fn validate_endpoint(raw: &str) -> Result<reqwest::Url, &'static str> {
    if raw.is_empty() || raw.len() > 2048 {
        return Err("invalid OIDC JWKS URL");
    }
    let endpoint = reqwest::Url::parse(raw).map_err(|_| "invalid OIDC JWKS URL")?;
    let literal_loopback = match endpoint.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    if !(endpoint.scheme() == "https" || (endpoint.scheme() == "http" && literal_loopback))
        || endpoint.host_str().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.fragment().is_some()
    {
        return Err("OIDC JWKS must be a credential-free HTTPS URL");
    }
    Ok(endpoint)
}

async fn pinned_client(
    endpoint: &reqwest::Url,
    allow_private: bool,
) -> Result<reqwest::Client, &'static str> {
    let host = endpoint.host_str().ok_or("OIDC JWKS host is missing")?;
    let bare_host = host.trim_matches(['[', ']']);
    if matches!(
        bare_host.to_ascii_lowercase().trim_end_matches('.'),
        "metadata.google.internal" | "metadata.goog"
    ) {
        return Err("metadata endpoints are not allowed");
    }
    let literal_loopback = endpoint.host().is_some_and(|host| match host {
        url::Host::Ipv4(ip) => ip.is_loopback(),
        url::Host::Ipv6(ip) => ip.is_loopback(),
        _ => false,
    });
    let port = endpoint
        .port_or_known_default()
        .ok_or("OIDC JWKS port is missing")?;
    let addresses: Vec<_> = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((bare_host, port)),
    )
    .await
    .map_err(|_| "OIDC JWKS DNS resolution timed out")?
    .map_err(|_| "OIDC JWKS DNS resolution failed")?
    .collect();
    if addresses.is_empty()
        || addresses
            .iter()
            .map(|address| address.ip())
            .any(|ip: IpAddr| !crate::allowed_address(ip, allow_private || literal_loopback))
    {
        return Err("OIDC JWKS resolved to a forbidden address");
    }
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(bare_host, &addresses)
        .connect_timeout(Duration::from_secs(5))
        .pool_max_idle_per_host(2)
        .build()
        .map_err(|_| "cannot initialize OIDC HTTP client")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_policies_match_only_bounded_signed_claim_shapes() {
        let policy: BTreeMap<String, Vec<String>> = serde_json::from_value(serde_json::json!({
            "realm":["workforce"], "org_role":["owner"]
        }))
        .unwrap();
        validate_claim_policy(&policy).unwrap();
        let claims = serde_json::json!({"realm":"workforce","org_role":["member","owner"]});
        assert!(matches_claims(&policy, claims.as_object().unwrap()));
        let denied = serde_json::json!({"realm":"workforce","org_role":"member"});
        assert!(!matches_claims(&policy, denied.as_object().unwrap()));
        let malformed: BTreeMap<String, Vec<String>> =
            serde_json::from_value(serde_json::json!({"__proto__":["owner"]})).unwrap();
        assert!(validate_claim_policy(&malformed).is_err());
    }
}
