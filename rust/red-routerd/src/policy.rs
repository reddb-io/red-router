use axum::http::{header, HeaderMap};
use serde_json::Value;
use std::sync::Arc;
use subtle::ConstantTimeEq;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(crate) struct ClientPolicies {
    entries: Vec<ClientPolicy>,
}

pub(crate) struct ClientPolicy {
    key: Arc<str>,
    enabled: bool,
    allowed_routes: Option<Vec<String>>,
    allowed_models: Option<Vec<String>>,
    allowed_endpoints: Vec<String>,
    blocked_models: Vec<String>,
    concurrency: Option<Arc<Semaphore>>,
}

impl ClientPolicies {
    pub(crate) fn single(key: &str) -> Self {
        Self {
            entries: vec![ClientPolicy {
                key: Arc::from(key),
                enabled: true,
                allowed_routes: None,
                allowed_models: None,
                allowed_endpoints: Vec::new(),
                blocked_models: Vec::new(),
                concurrency: None,
            }],
        }
    }

    pub(crate) fn parse<F>(config: &str, resolve: F) -> Result<Self, &'static str>
    where
        F: Fn(&str) -> Option<String>,
    {
        if config.len() > 256 * 1024 {
            return Err("client policies are too large");
        }
        let value: Value =
            serde_json::from_str(config).map_err(|_| "invalid client policies JSON")?;
        let policies = value.as_array().ok_or("client policies must be an array")?;
        if policies.is_empty() || policies.len() > 64 {
            return Err("client policies must contain 1-64 entries");
        }
        let mut entries: Vec<ClientPolicy> = Vec::new();
        for policy in policies {
            let object = policy.as_object().ok_or("invalid client policy")?;
            if object.keys().any(|name| {
                ![
                    "api_key_env",
                    "enabled",
                    "allowed_routes",
                    "allowed_models",
                    "allowed_endpoints",
                    "blocked_models",
                    "max_concurrent_requests",
                ]
                .contains(&name.as_str())
            }) {
                return Err("unknown client policy field");
            }
            let name = object
                .get("api_key_env")
                .and_then(Value::as_str)
                .filter(|name| {
                    !name.is_empty()
                        && name.len() <= 128
                        && name
                            .bytes()
                            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                })
                .ok_or("invalid client key environment variable")?;
            let key = resolve(name).ok_or("client key is missing")?;
            if !(16..=512).contains(&key.len())
                || entries
                    .iter()
                    .any(|entry| entry.key.as_ref() == key.as_str())
            {
                return Err("client keys must be unique and 16-512 bytes");
            }
            let enabled = match object.get("enabled") {
                None => true,
                Some(value) => value
                    .as_bool()
                    .ok_or("invalid client policy enabled flag")?,
            };
            let allowed_routes = object
                .get("allowed_routes")
                .map(parse_patterns)
                .transpose()?;
            let allowed_models = object
                .get("allowed_models")
                .map(parse_patterns)
                .transpose()?;
            let allowed_endpoints = match object.get("allowed_endpoints") {
                None => Vec::new(),
                Some(value) => {
                    let entries = value
                        .as_array()
                        .ok_or("endpoint categories must be an array")?;
                    if entries.len() > 20 {
                        return Err("too many endpoint categories");
                    }
                    entries
                        .iter()
                        .map(|entry| {
                            entry
                                .as_str()
                                .map(str::trim)
                                .filter(|name| !name.is_empty() && name.len() <= 64)
                                .map(str::to_owned)
                                .ok_or("invalid endpoint category")
                        })
                        .collect::<Result<Vec<_>, _>>()?
                }
            };
            let blocked_models = object
                .get("blocked_models")
                .map(parse_patterns)
                .transpose()?
                .unwrap_or_default();
            let concurrency = match object.get("max_concurrent_requests") {
                None => None,
                Some(value) => {
                    let count = value
                        .as_u64()
                        .filter(|count| (1..=super::MAX_IN_FLIGHT as u64).contains(count))
                        .ok_or("invalid client concurrency limit")?;
                    Some(Arc::new(Semaphore::new(count as usize)))
                }
            };
            entries.push(ClientPolicy {
                key: Arc::from(key),
                enabled,
                allowed_routes,
                allowed_models,
                allowed_endpoints,
                blocked_models,
                concurrency,
            });
        }
        Ok(Self { entries })
    }

    pub(crate) fn authenticate(
        &self,
        headers: &HeaderMap,
        protocol: super::ProviderProtocol,
    ) -> Option<&ClientPolicy> {
        let mut values = headers.get_all(header::AUTHORIZATION).iter();
        let mut api_keys = headers.get_all("x-api-key").iter();
        let mut google_keys = headers.get_all("x-goog-api-key").iter();
        let authorization = values.next();
        let api_key = api_keys.next();
        let google_key = google_keys.next();
        if values.next().is_some()
            || api_keys.next().is_some()
            || google_keys.next().is_some()
            || [
                authorization.is_some(),
                api_key.is_some(),
                google_key.is_some(),
            ]
            .into_iter()
            .filter(|v| *v)
            .count()
                != 1
        {
            return None;
        }
        let candidate = match (authorization, api_key, google_key) {
            (Some(value), None, None) => value.to_str().ok()?.strip_prefix("Bearer ")?,
            (None, Some(value), None) if protocol == super::ProviderProtocol::Anthropic => {
                value.to_str().ok()?
            }
            (None, None, Some(value)) if protocol == super::ProviderProtocol::Gemini => {
                value.to_str().ok()?
            }
            _ => return None,
        };
        if !(16..=512).contains(&candidate.len()) {
            return None;
        }
        // Examine every configured key rather than stopping at the first match.
        let mut matched = None;
        for policy in &self.entries {
            if bool::from(candidate.as_bytes().ct_eq(policy.key.as_bytes())) && policy.enabled {
                matched = Some(policy);
            }
        }
        matched
    }
}

impl ClientPolicy {
    pub(crate) fn try_acquire(&self) -> Result<Option<OwnedSemaphorePermit>, ()> {
        self.concurrency
            .as_ref()
            .map(|semaphore| semaphore.clone().try_acquire_owned().map_err(|_| ()))
            .transpose()
    }

    // Every currently implemented generation endpoint belongs to RedRouter's
    // chat category; empty lists retain the product's unrestricted behavior.
    pub(crate) fn chat_endpoint_allowed(&self) -> bool {
        self.allowed_endpoints.is_empty()
            || self
                .allowed_endpoints
                .iter()
                .any(|category| category == "chat")
    }

    pub(crate) fn route_allowed(&self, model: &str) -> bool {
        !self.model_blocked(model)
            && self
                .allowed_routes
                .as_ref()
                .is_none_or(|patterns| patterns.iter().any(|p| matches_pattern(p, model)))
    }

    pub(crate) fn target_allowed(&self, model: &str) -> bool {
        !self.model_blocked(model)
            && self.allowed_models.as_ref().is_none_or(|patterns| {
                patterns
                    .iter()
                    .any(|pattern| matches_pattern(pattern, model))
            })
    }

    pub(crate) fn model_blocked(&self, model: &str) -> bool {
        self.blocked_models
            .iter()
            .any(|p| matches_pattern(p, model))
    }
}

fn parse_patterns(value: &Value) -> Result<Vec<String>, &'static str> {
    let values = value.as_array().ok_or("policy patterns must be an array")?;
    if values.len() > 128 {
        return Err("too many policy patterns");
    }
    values
        .iter()
        .map(|value| {
            let pattern = value
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256)
                .ok_or("invalid policy pattern")?;
            if pattern != "*"
                && pattern.contains('*')
                && !(pattern.ends_with("/*") && !pattern[..pattern.len() - 1].contains('*'))
            {
                return Err("unsupported policy wildcard");
            }
            Ok(pattern.to_string())
        })
        .collect()
}

fn matches_pattern(pattern: &str, value: &str) -> bool {
    pattern == "*"
        || pattern == value
        || pattern
            .strip_suffix('*')
            .is_some_and(|prefix| pattern.ends_with("/*") && value.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_patterns_have_explicit_prefix_boundaries() {
        assert!(matches_pattern("provider/*", "provider/model"));
        assert!(!matches_pattern("provider/*", "providers/model"));
        assert!(!matches_pattern("provider/*", "provider"));
        assert!(matches_pattern("*", "any/model"));
        assert!(!matches_pattern("exact", "exact/other"));
    }
}
