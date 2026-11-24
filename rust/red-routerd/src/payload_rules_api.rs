//! Global operator payload rules (legacy `settings.payloadRules`): storage
//! snapshot and the admin API. Only a global administrator may change them,
//! since they apply to every organization's upstream requests.
use super::*;
use crate::payload_rules::{normalize_payload_rules_config, PayloadRulesConfig};
use crate::storage::StoredPayloadRules;

/// The stored rules, or none.
pub(super) fn stored_config(
    stored: Option<&StoredPayloadRules>,
) -> Result<PayloadRulesConfig, &'static str> {
    match stored {
        Some(stored) => {
            serde_json::from_str(&stored.config_json).map_err(|_| "invalid payload rules storage")
        }
        None => Ok(PayloadRulesConfig::default()),
    }
}

impl ControlPlane {
    pub(super) async fn refresh_payload_rules(&self) -> Result<(), &'static str> {
        let rules = stored_config(self.0.database.payload_rules().await?.as_ref())?;
        *self.0.payload_rules.write().await = Arc::new(rules);
        Ok(())
    }

    pub(crate) async fn payload_rules(&self) -> Arc<PayloadRulesConfig> {
        self.0.payload_rules.read().await.clone()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PayloadRulesInput {
    /// Rules in the legacy shape; invalid entries are dropped like the legacy
    /// `normalizePayloadRulesConfig`.
    rules: serde_json::Value,
    /// The revision being replaced; omitted when no rules are stored yet.
    revision: Option<String>,
}

fn view(stored: Option<&StoredPayloadRules>) -> Result<serde_json::Value, &'static str> {
    Ok(serde_json::json!({
        "rules": stored_config(stored)?,
        "revision": stored.map(|stored| stored.revision.to_string()),
    }))
}

pub async fn get(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    if control.authorized_admin_actor(&headers).await.is_none() {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    match control.0.database.payload_rules().await {
        Ok(stored) => match view(stored.as_ref()) {
            Ok(view) => ([(header::CACHE_CONTROL, "no-store")], Json(view)).into_response(),
            Err(error) => api_error(StatusCode::SERVICE_UNAVAILABLE, error),
        },
        Err(error) => api_error(StatusCode::SERVICE_UNAVAILABLE, error),
    }
}

pub async fn put(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Json(input): Json<PayloadRulesInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(actor) = control.authorized_admin_actor(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    let expected = match input.revision.as_deref().map(str::parse::<i64>).transpose() {
        Ok(expected) => expected,
        Err(_) => return api_error(StatusCode::BAD_REQUEST, "Invalid payload rules revision"),
    };
    let _mutation = control.0.mutation.lock().await;
    let result: Result<serde_json::Value, &'static str> = async {
        let before = control.0.database.payload_rules().await?;
        if before.as_ref().map(|stored| stored.revision) != expected {
            return Err("Payload rules changed; reload and retry");
        }
        let rules = normalize_payload_rules_config(&input.rules);
        let stored = StoredPayloadRules {
            config_json: serde_json::to_string(&rules).map_err(|_| "Invalid payload rules")?,
            revision: revision()?,
        };
        control
            .0
            .database
            .upsert_payload_rules(&stored, expected)
            .await?;
        control.refresh_payload_rules().await?;
        let before_view = view(before.as_ref())?;
        let after_view = view(Some(&stored))?;
        control
            .record_audit_event(
                AuditContext {
                    action: "payload_rules.update",
                    actor: &actor,
                    tenant_id: "red",
                    target: "global",
                    resource_type: "payload_rules",
                },
                Some(&before_view),
                Some(&after_view),
            )
            .await;
        Ok(after_view)
    }
    .await;
    match result {
        Ok(view) => ([(header::CACHE_CONTROL, "no-store")], Json(view)).into_response(),
        Err(error) if error.contains("changed; reload") => api_error(StatusCode::CONFLICT, error),
        Err(error) => api_error(StatusCode::SERVICE_UNAVAILABLE, error),
    }
}
