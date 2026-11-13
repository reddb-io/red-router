use axum::http::{header, HeaderMap};
use chrono::{Datelike, Timelike};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(crate) struct ClientPolicies {
    entries: Vec<ClientPolicy>,
}

pub(crate) struct ClientPolicy {
    model_matching: crate::model_permissions::ModelMatching,
    credential: ClientCredential,
    identity: Option<ClientIdentity>,
    enabled: bool,
    expires_at_unix: Option<u64>,
    access_schedule: Option<AccessSchedule>,
    scopes: Vec<String>,
    allowed_routes: Option<Vec<String>>,
    allowed_combos: Option<Vec<String>>,
    allowed_models: Option<Vec<String>>,
    allowed_endpoints: Vec<String>,
    blocked_models: Vec<String>,
    allowed_provider_ids: Vec<String>,
    concurrency: Option<Arc<Semaphore>>,
    rate_limit: Option<RateLimit>,
}

#[derive(Clone, Debug)]
pub(crate) struct ClientIdentity {
    pub id: Arc<str>,
    pub name: Arc<str>,
    pub tenant_id: Arc<str>,
    pub role: &'static str,
    pub id_format: Arc<str>,
    pub max_requests_per_minute: Option<usize>,
    pub max_requests_per_day: Option<usize>,
    pub usage_quota: Option<crate::native_usage::NativeQuota>,
}

enum ClientCredential {
    Plain(Arc<str>),
    Sha256([u8; 32]),
}

pub(crate) struct StoredPolicy {
    pub model_matching: crate::model_permissions::ModelMatching,
    pub id: String,
    pub name: String,
    pub tenant_id: String,
    pub model_id_format: String,
    pub model_access_restricted: bool,
    pub allowed_combos: Option<Vec<String>>,
    pub key_hash: [u8; 32],
    pub enabled: bool,
    pub expires_at_unix: Option<u64>,
    pub access_schedule: Option<AccessScheduleConfig>,
    pub scopes: Vec<String>,
    pub allowed_models: Vec<String>,
    pub allowed_endpoints: Vec<String>,
    pub blocked_models: Vec<String>,
    pub allowed_provider_ids: Vec<String>,
    pub max_concurrent_requests: Option<usize>,
    pub max_requests_per_minute: Option<usize>,
    pub max_requests_per_day: Option<usize>,
    pub usage_quota: Option<crate::native_usage::NativeQuota>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AccessScheduleConfig {
    pub enabled: bool,
    pub from: String,
    pub until: String,
    pub days: Vec<u8>,
    pub tz: String,
}

struct AccessSchedule {
    from_minutes: u16,
    until_minutes: u16,
    days: u8,
    timezone: Tz,
}

impl AccessScheduleConfig {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if parse_schedule_time(&self.from).is_none()
            || parse_schedule_time(&self.until).is_none()
            || self.days.len() > 7
            || self.days.iter().any(|day| *day > 6)
            || self
                .days
                .iter()
                .enumerate()
                .any(|(index, day)| self.days[..index].contains(day))
            || self.tz.is_empty()
            || self.tz.len() > 100
            || self.tz.chars().any(char::is_control)
            || self.tz.parse::<Tz>().is_err()
        {
            return Err("invalid client key access schedule");
        }
        Ok(())
    }

    fn compile(&self) -> Result<Option<AccessSchedule>, &'static str> {
        self.validate()?;
        if !self.enabled {
            return Ok(None);
        }
        let mut days = 0_u8;
        for day in &self.days {
            days |= 1 << day;
        }
        Ok(Some(AccessSchedule {
            from_minutes: parse_schedule_time(&self.from)
                .ok_or("invalid client key access schedule")?,
            until_minutes: parse_schedule_time(&self.until)
                .ok_or("invalid client key access schedule")?,
            days,
            timezone: self
                .tz
                .parse()
                .map_err(|_| "invalid client key access schedule")?,
        }))
    }
}

fn parse_schedule_time(value: &str) -> Option<u16> {
    if value.len() != 5 || value.as_bytes().get(2) != Some(&b':') {
        return None;
    }
    let hour = value.get(..2)?.parse::<u16>().ok()?;
    let minute = value.get(3..)?.parse::<u16>().ok()?;
    (hour < 24 && minute < 60).then_some(hour * 60 + minute)
}

impl AccessSchedule {
    fn allows(&self, now: std::time::SystemTime) -> bool {
        let local = chrono::DateTime::<chrono::Utc>::from(now).with_timezone(&self.timezone);
        let day = local.weekday().num_days_from_sunday() as u8;
        if self.days & (1 << day) == 0 {
            return false;
        }
        let minutes = (local.hour() * 60 + local.minute()) as u16;
        if self.until_minutes < self.from_minutes {
            minutes >= self.from_minutes || minutes < self.until_minutes
        } else {
            minutes >= self.from_minutes && minutes < self.until_minutes
        }
    }
}

struct RateLimit {
    minute: Option<usize>,
    day: Option<usize>,
    requests: Mutex<(VecDeque<Instant>, VecDeque<Instant>)>,
}

impl RateLimit {
    fn admit(&self, now: Instant) -> bool {
        let Ok(mut requests) = self.requests.lock() else {
            return false;
        };
        let (minute, day) = &mut *requests;
        // Calls can reach the mutex in a different order from their timestamp.
        // Keep the queues monotonic so expiry never undercounts recent requests.
        let now = minute
            .back()
            .into_iter()
            .chain(day.back())
            .fold(now, |now, last| now.max(*last));
        while minute
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= Duration::from_secs(60))
        {
            minute.pop_front();
        }
        while day
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= Duration::from_secs(86_400))
        {
            day.pop_front();
        }
        if self.minute.is_some_and(|limit| minute.len() >= limit)
            || self.day.is_some_and(|limit| day.len() >= limit)
        {
            return false;
        }
        if self.minute.is_some() {
            minute.push_back(now);
        }
        if self.day.is_some() {
            day.push_back(now);
        }
        true
    }
}

impl ClientPolicies {
    pub(crate) fn single(key: &str) -> Self {
        Self {
            entries: vec![ClientPolicy {
                model_matching: Default::default(),
                credential: ClientCredential::Plain(Arc::from(key)),
                identity: None,
                enabled: true,
                expires_at_unix: None,
                access_schedule: None,
                scopes: Vec::new(),
                allowed_routes: None,
                allowed_combos: None,
                allowed_models: None,
                allowed_endpoints: Vec::new(),
                blocked_models: Vec::new(),
                allowed_provider_ids: Vec::new(),
                concurrency: None,
                rate_limit: None,
            }],
        }
    }

    pub(crate) fn from_stored(policies: Vec<StoredPolicy>) -> Result<Self, &'static str> {
        let entries = policies
            .into_iter()
            .map(|policy| {
                let access_schedule = policy
                    .access_schedule
                    .map(|schedule| schedule.compile())
                    .transpose()?
                    .flatten();
                let allowed_models =
                    if policy.allowed_models.is_empty() && !policy.model_access_restricted {
                        None
                    } else {
                        Some(policy.allowed_models)
                    };
                let concurrency = policy
                    .max_concurrent_requests
                    .map(|limit| Arc::new(Semaphore::new(limit)));
                let rate_limit = (policy.max_requests_per_minute.is_some()
                    || policy.max_requests_per_day.is_some())
                .then(|| RateLimit {
                    minute: policy.max_requests_per_minute,
                    day: policy.max_requests_per_day,
                    requests: Mutex::new((VecDeque::new(), VecDeque::new())),
                });
                Ok(ClientPolicy {
                    model_matching: policy.model_matching,
                    credential: ClientCredential::Sha256(policy.key_hash),
                    identity: Some(ClientIdentity {
                        id: Arc::from(policy.id),
                        name: Arc::from(policy.name),
                        tenant_id: Arc::from(policy.tenant_id),
                        role: if policy
                            .scopes
                            .iter()
                            .any(|scope| matches!(scope.as_str(), "manage" | "admin"))
                        {
                            "admin"
                        } else {
                            "standard"
                        },
                        id_format: Arc::from(policy.model_id_format),
                        max_requests_per_minute: policy.max_requests_per_minute,
                        max_requests_per_day: policy.max_requests_per_day,
                        usage_quota: policy.usage_quota,
                    }),
                    enabled: policy.enabled,
                    expires_at_unix: policy.expires_at_unix,
                    access_schedule,
                    scopes: policy.scopes,
                    allowed_routes: None,
                    allowed_models,
                    allowed_combos: policy.allowed_combos,
                    allowed_endpoints: policy.allowed_endpoints,
                    blocked_models: policy.blocked_models,
                    allowed_provider_ids: policy.allowed_provider_ids,
                    concurrency,
                    rate_limit,
                })
            })
            .collect::<Result<Vec<_>, &'static str>>()?;
        Ok(Self { entries })
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
                    "expires_at_unix",
                    "allowed_routes",
                    "allowed_models",
                    "allowed_endpoints",
                    "blocked_models",
                    "max_concurrent_requests",
                    "max_requests_per_minute",
                    "max_requests_per_day",
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
                || entries.iter().any(|entry| match &entry.credential {
                    ClientCredential::Plain(existing) => existing.as_ref() == key.as_str(),
                    ClientCredential::Sha256(_) => false,
                })
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
            let expires_at_unix = object
                .get("expires_at_unix")
                .map(|value| value.as_u64().ok_or("invalid client key expiry"))
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
            let parse_limit = |name| {
                object
                    .get(name)
                    .map(|value| {
                        value
                            .as_u64()
                            .filter(|count| (1..=10_000).contains(count))
                            .map(|count| count as usize)
                            .ok_or("invalid client rate limit")
                    })
                    .transpose()
            };
            let minute = parse_limit("max_requests_per_minute")?;
            let day = parse_limit("max_requests_per_day")?;
            let rate_limit = (minute.is_some() || day.is_some()).then(|| RateLimit {
                minute,
                day,
                requests: Mutex::new((VecDeque::new(), VecDeque::new())),
            });
            entries.push(ClientPolicy {
                model_matching: Default::default(),
                credential: ClientCredential::Plain(Arc::from(key)),
                identity: None,
                enabled,
                expires_at_unix,
                access_schedule: None,
                scopes: Vec::new(),
                allowed_routes,
                allowed_combos: None,
                allowed_models,
                allowed_endpoints,
                blocked_models,
                allowed_provider_ids: Vec::new(),
                concurrency,
                rate_limit,
            });
        }
        Ok(Self { entries })
    }

    pub(crate) fn authenticate(
        &self,
        headers: &HeaderMap,
        protocol: super::ProviderProtocol,
    ) -> Option<&ClientPolicy> {
        let candidate = extract_candidate(headers, protocol)?;
        let candidate_hash: [u8; 32] = Sha256::digest(candidate.as_bytes()).into();
        // Examine every configured key rather than stopping at the first match.
        let mut matched = None;
        for policy in &self.entries {
            let credential_matches = match &policy.credential {
                ClientCredential::Plain(key) => {
                    bool::from(candidate.as_bytes().ct_eq(key.as_bytes()))
                }
                ClientCredential::Sha256(hash) => bool::from(candidate_hash.ct_eq(hash)),
            };
            if credential_matches && policy.is_active() {
                matched = Some(policy);
            }
        }
        matched
    }

    pub(crate) fn has_active(&self) -> bool {
        self.entries.iter().any(ClientPolicy::is_active)
    }
}

pub(crate) fn extract_candidate(
    headers: &HeaderMap,
    protocol: super::ProviderProtocol,
) -> Option<&str> {
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
    Some(candidate)
}

impl ClientPolicy {
    fn is_active(&self) -> bool {
        self.enabled
            && self.expires_at_unix.is_none_or(|deadline| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .is_ok_and(|elapsed| elapsed.as_secs() < deadline)
            })
            && self
                .access_schedule
                .as_ref()
                .is_none_or(|schedule| schedule.allows(std::time::SystemTime::now()))
    }

    pub(crate) fn allow_request(&self) -> bool {
        self.rate_limit
            .as_ref()
            .is_none_or(|limit| limit.admit(Instant::now()))
    }
    pub(crate) fn try_acquire(&self) -> Result<Option<OwnedSemaphorePermit>, ()> {
        self.concurrency
            .as_ref()
            .map(|semaphore| semaphore.clone().try_acquire_owned().map_err(|_| ()))
            .transpose()
    }

    // Empty endpoint lists retain the product's unrestricted behavior.
    pub(crate) fn endpoint_allowed(&self, endpoint: &str) -> bool {
        let scope_allowed = self.scopes.is_empty()
            || self
                .scopes
                .iter()
                .any(|scope| scope == "inference:*" || scope == &format!("inference:{endpoint}"));
        scope_allowed
            && (self.allowed_endpoints.is_empty()
                || self
                    .allowed_endpoints
                    .iter()
                    .any(|category| category == endpoint))
    }

    pub(crate) fn route_allowed(&self, model: &str) -> bool {
        !self.model_blocked(model)
            && self
                .allowed_routes
                .as_ref()
                .is_none_or(|patterns| patterns.iter().any(|p| matches_pattern(p, model)))
    }

    pub(crate) fn combo_allowed(&self, combo: &str) -> bool {
        match &self.allowed_combos {
            None if self.model_matching.legacy() => true,
            None => self.route_allowed(combo) && self.route_allowed(combo_name(combo)),
            Some(grants) => grants
                .iter()
                .any(|rule| rule == "combo/*" || combo_name(rule) == combo_name(combo)),
        }
    }

    pub(crate) fn combo_target_allowed(&self, combo: &str, model: &str) -> bool {
        if self.model_matching.legacy() {
            if !self.combo_allowed(combo) {
                return false;
            }
            if (self.allowed_models.as_ref().is_none_or(Vec::is_empty)
                && self.blocked_models.is_empty())
                || (self.allowed_combos.is_some() && !combo_name(combo).starts_with("auto/"))
            {
                return true;
            }
            if self.model_blocked(model) {
                return false;
            }
            // The old combo gate uses exact/literal prefix matching on the requested
            // combo, not the more permissive model glob/alias matcher.
            if self.allowed_models.as_ref().is_some_and(|patterns| {
                patterns.iter().any(|pattern| {
                    pattern == combo
                        || pattern.strip_suffix('*').is_some_and(|prefix| {
                            pattern.ends_with("/*") && combo.starts_with(prefix)
                        })
                })
            }) {
                return true;
            }
            return self.target_allowed(model);
        }
        self.combo_allowed(combo)
            && if self.allowed_combos.is_some()
                && (!combo_name(combo).starts_with("auto/")
                    || (self.allowed_models.as_ref().is_none_or(Vec::is_empty)
                        && self.blocked_models.is_empty()))
            {
                // The legacy product grants curated combos independently of direct model access.
                // Endpoint, provider, tenant, budget and quota gates still apply at dispatch.
                true
            } else {
                self.target_allowed(model)
            }
    }

    pub(crate) fn target_allowed(&self, model: &str) -> bool {
        !self.model_blocked(model)
            && self
                .allowed_models
                .as_ref()
                .is_none_or(|patterns| self.model_matching.matches(patterns, model))
    }

    pub(crate) fn model_blocked(&self, model: &str) -> bool {
        self.model_matching.matches(&self.blocked_models, model)
    }

    pub(crate) fn combo_provider_target_allowed(
        &self,
        combo: &str,
        model: &str,
        provider: Option<&str>,
    ) -> bool {
        if self.model_matching.legacy() {
            if let Some(provider) = provider {
                return self.combo_target_allowed(combo, &format!("{provider}/{model}"));
            }
        }
        self.combo_target_allowed(combo, model)
    }

    pub(crate) fn provider_allowed(&self, provider_id: Option<&str>) -> bool {
        self.allowed_provider_ids.is_empty()
            || provider_id.is_some_and(|id| {
                self.allowed_provider_ids
                    .iter()
                    .any(|allowed| allowed == id)
            })
    }

    pub(crate) fn tenant_allowed(&self, tenant_id: &str) -> bool {
        self.identity
            .as_ref()
            .map_or(tenant_id == "red", |identity| {
                identity.tenant_id.as_ref() == tenant_id
            })
    }

    pub(crate) fn identity(&self) -> Option<&ClientIdentity> {
        self.identity.as_ref()
    }
}

fn combo_name(value: &str) -> &str {
    let value = value.trim();
    value
        .strip_prefix("combo/")
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(value)
}

pub(crate) fn validate_combo_grants(grants: &[String]) -> Result<(), &'static str> {
    if grants.len() > 128
        || grants.iter().any(|value| {
            value.trim().is_empty()
                || value.len() > 256
                || value.chars().any(char::is_control)
                || (value.contains('*') && value != "combo/*")
        })
    {
        return Err("invalid client key combo grants");
    }
    Ok(())
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
    fn imported_model_rules_preserve_alias_deny_precedence_and_combo_target_semantics() {
        let mut policies = ClientPolicies::single("fixture");
        let policy = &mut policies.entries[0];
        policy.model_matching = crate::model_permissions::ModelMatching::Legacy {
            prefer_claude_code: false,
        };
        policy.allowed_models = Some(vec![]);
        assert!(!policy.target_allowed("codex/gpt-5"));
        assert!(policy.combo_provider_target_allowed("team", "gpt-5", Some("codex")));
        policy.allowed_models = Some(vec!["cx/gpt-*".into(), "team".into()]);
        policy.blocked_models = vec!["codex/gpt-secret*".into()];
        assert!(policy.target_allowed("codex/gpt-5"));
        assert!(!policy.target_allowed("cx/gpt-secret-mini[1m]"));
        assert!(!policy.target_allowed("openai/gpt-5"));
        assert!(policy.combo_provider_target_allowed("unrestricted-name", "gpt-5", Some("codex")));
        assert!(!policy.combo_provider_target_allowed("unrestricted-name", "other", Some("codex")));
        assert!(policy.combo_provider_target_allowed("team", "other", Some("codex")));
        assert!(!policy.combo_provider_target_allowed("team", "gpt-secret", Some("codex")));
        policy.allowed_combos = Some(vec!["team".into(), "auto/dynamic".into()]);
        assert!(policy.combo_provider_target_allowed("team", "gpt-secret", Some("codex")));
        assert!(!policy.combo_provider_target_allowed("auto/dynamic", "gpt-secret", Some("codex")));
        assert!(!policy.combo_provider_target_allowed("other", "gpt-5", Some("codex")));
        policy.allowed_combos = None;
        policy.allowed_models = Some(vec!["*".into()]);
        policy.blocked_models.clear();
        assert!(policy.target_allowed("unprefixed"));
        assert!(!policy.target_allowed("openai/gpt-4"));
        assert!(!policy.combo_provider_target_allowed("team", "gpt-4", Some("openai")));
    }

    #[test]
    fn supported_patterns_have_explicit_prefix_boundaries() {
        assert!(matches_pattern("provider/*", "provider/model"));
        assert!(!matches_pattern("provider/*", "providers/model"));
        assert!(!matches_pattern("provider/*", "provider"));
        assert!(matches_pattern("*", "any/model"));
        assert!(!matches_pattern("exact", "exact/other"));
    }

    #[test]
    fn access_schedule_validates_timezone_days_and_time_bounds() {
        let valid = AccessScheduleConfig {
            enabled: true,
            from: "08:00".to_owned(),
            until: "18:00".to_owned(),
            days: vec![1, 2, 3, 4, 5],
            tz: "America/Sao_Paulo".to_owned(),
        };
        assert!(valid.validate().is_ok());
        for invalid in [
            AccessScheduleConfig {
                from: "24:00".to_owned(),
                ..valid.clone()
            },
            AccessScheduleConfig {
                days: vec![1, 1],
                ..valid.clone()
            },
            AccessScheduleConfig {
                tz: "Mars/Olympus".to_owned(),
                ..valid.clone()
            },
        ] {
            assert!(invalid.validate().is_err());
        }
    }

    #[test]
    fn access_schedule_uses_iana_timezone_and_overnight_windows() {
        let schedule = AccessScheduleConfig {
            enabled: true,
            from: "22:00".to_owned(),
            until: "06:00".to_owned(),
            days: vec![1],
            tz: "America/Sao_Paulo".to_owned(),
        }
        .compile()
        .unwrap()
        .unwrap();
        let at = |unix| std::time::UNIX_EPOCH + std::time::Duration::from_secs(unix);
        // 2024-03-11 23:00 and 2024-03-11 05:30 in Sao Paulo.
        assert!(schedule.allows(at(1_710_208_800)));
        assert!(schedule.allows(at(1_710_145_800)));
        // 2024-03-11 12:00 in Sao Paulo.
        assert!(!schedule.allows(at(1_710_169_200)));
    }

    #[test]
    fn empty_schedule_days_remain_deny_all_and_disabled_schedule_is_inert() {
        let config = AccessScheduleConfig {
            enabled: true,
            from: "00:00".to_owned(),
            until: "23:59".to_owned(),
            days: vec![],
            tz: "UTC".to_owned(),
        };
        let schedule = config.compile().unwrap().unwrap();
        for day in 0..7 {
            assert!(!schedule
                .allows(std::time::UNIX_EPOCH + Duration::from_secs(1_710_169_200 + day * 86_400)));
        }
        assert!(AccessScheduleConfig {
            enabled: false,
            ..config
        }
        .compile()
        .unwrap()
        .is_none());
    }

    #[test]
    fn expiry_must_be_an_unsigned_unix_timestamp() {
        for value in ["-1", "null", "1.5", "\"2030-01-01\""] {
            let config = format!(r#"[{{"api_key_env":"KEY","expires_at_unix":{value}}}]"#);
            assert!(
                ClientPolicies::parse(&config, |_| Some("client-key-12345678".into())).is_err()
            );
        }
    }

    #[test]
    fn rate_limit_uses_a_rolling_minute_and_rejects_invalid_limits() {
        let limit = RateLimit {
            minute: Some(2),
            day: None,
            requests: Mutex::new((VecDeque::new(), VecDeque::new())),
        };
        let start = Instant::now();
        assert!(limit.admit(start));
        assert!(limit.admit(start + Duration::from_secs(1)));
        assert!(!limit.admit(start + Duration::from_secs(59)));
        assert!(limit.admit(start + Duration::from_secs(60)));
        assert!(!limit.admit(start + Duration::from_secs(60)));
        assert!(limit.admit(start + Duration::from_secs(61)));
        for field in ["max_requests_per_minute", "max_requests_per_day"] {
            for value in ["0", "-1", "10001", "null", "1.5"] {
                let config = format!(r#"[{{"api_key_env":"KEY","{field}":{value}}}]"#);
                assert!(
                    ClientPolicies::parse(&config, |_| Some("client-key-12345678".into())).is_err()
                );
            }
        }
    }

    #[test]
    fn minute_and_day_limits_are_admitted_together() {
        let limit = RateLimit {
            minute: Some(2),
            day: Some(3),
            requests: Mutex::new((VecDeque::new(), VecDeque::new())),
        };
        let start = Instant::now();
        assert!(limit.admit(start));
        assert!(limit.admit(start + Duration::from_secs(1)));
        assert!(!limit.admit(start + Duration::from_secs(2)));
        assert!(limit.admit(start + Duration::from_secs(60)));
        assert!(!limit.admit(start + Duration::from_secs(121)));
        assert!(limit.admit(start + Duration::from_secs(86_400)));
    }

    #[test]
    fn rate_limit_admission_is_atomic_under_concurrency() {
        let limit = Arc::new(RateLimit {
            minute: Some(4),
            day: Some(4),
            requests: Mutex::new((VecDeque::new(), VecDeque::new())),
        });
        let now = Instant::now();
        let threads: Vec<_> = (0..32)
            .map(|_| {
                let limit = limit.clone();
                std::thread::spawn(move || limit.admit(now))
            })
            .collect();
        let admitted = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(|admitted| *admitted)
            .count();
        assert_eq!(admitted, 4);
    }
}

#[cfg(test)]
mod combo_permission_tests {
    use super::ClientPolicies;

    #[test]
    fn explicit_combo_grants_do_not_grant_direct_models_or_override_auto_target_checks() {
        let mut policies = ClientPolicies::single("fixture-client-key-0000001");
        let policy = &mut policies.entries[0];
        policy.allowed_models = Some(vec![]);
        assert!(!policy.target_allowed("gpt-4o"));
        assert!(!policy.combo_target_allowed("team", "gpt-4o"));
        policy.allowed_combos = Some(vec!["combo/team".into(), "auto/work".into()]);
        assert!(policy.combo_allowed("team"));
        assert!(policy.combo_allowed("combo/team"));
        assert!(!policy.combo_allowed("another"));
        assert!(policy.combo_target_allowed("team", "gpt-4o"));
        assert!(!policy.target_allowed("gpt-4o"));
        assert!(policy.combo_target_allowed("auto/work", "gpt-4o"));
        policy.blocked_models.push("gpt-4o".into());
        assert!(policy.combo_target_allowed("team", "gpt-4o"));
        assert!(!policy.combo_target_allowed("auto/work", "gpt-4o"));
        policy.allowed_combos = Some(vec![]);
        assert!(!policy.combo_allowed("team"));
    }
}
