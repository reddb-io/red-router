//! The legacy table inventory: an explicit cutover decision for every table a
//! legacy store can hold, so no table with rows is left behind silently.
//!
//! A table is either handled by an importer stage (which applies its own
//! refusals), archived losslessly by `legacy_archive`, dropped by design
//! (process-local runtime state, caches and derived data the legacy server
//! itself rebuilds), or refused while it holds rows the native daemon cannot
//! honor yet. Tables a fresh legacy install seeds are refused only for rows
//! that differ from the seed. A table outside the inventory refuses as soon
//! as it holds a row.

use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use std::path::Path;

/// Why a legacy table is accepted or refused by the cutover.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TableClass {
    /// An importer stage reads it and applies its own refusals.
    Handled,
    /// `legacy_archive` copies it losslessly into a read-only staging table.
    Archived,
    /// Runtime state, a cache or derived data; dropped by design.
    Dropped(&'static str),
    /// Refused while it holds rows: the native daemon has no equivalent yet.
    Refused(&'static str),
    /// Seeded by a fresh install: refused for any row matching `NOT (seed)`.
    Seeded {
        feature: &'static str,
        seed: &'static str,
    },
}

use TableClass::{Archived, Dropped, Handled, Refused, Seeded};

/// Legacy logs and history copied by `legacy_archive`.
pub const ARCHIVED: &[&str] = &[
    // Staged for adoption once their providers are adopted.
    "combos",
    "call_logs",
    "proxy_logs",
    "request_detail_logs",
    "routing_decisions",
    "domain_budget_reset_logs",
    "domain_cost_history",
    "hourly_usage_summary",
    "daily_usage_summary",
    "quota_snapshots",
    "provider_quota_reset_events",
    "api_key_token_limit_reset_logs",
    "config_audit_log",
    "mcp_tool_audit",
    "a2a_task_events",
    "server_tool_executions",
    "skill_executions",
    "guardrail_events",
    "middleware_logs",
    "relay_logs",
    "webhook_deliveries",
    "free_proxy_sync_errors",
    "job_runs",
    "compression_analytics",
    "plugin_metrics",
    "plugin_analytics",
    "inspector_sessions",
    "inspector_session_requests",
    "xp_audit_log",
];

const INVENTORY: &[(&str, TableClass)] = &[
    // Importer stages.
    ("key_value", Handled),
    ("provider_connections", Handled),
    ("provider_nodes", Handled),
    ("api_keys", Handled),
    ("tenants", Handled),
    ("usage_history", Handled),
    ("request_cost_ledger", Handled),
    ("redrouter_usage_deliveries", Handled),
    ("cost_ledger_outbox", Handled),
    ("api_key_quota_limits", Handled),
    ("api_key_quota_counters", Handled),
    ("api_key_daily_token_limits", Handled),
    ("api_key_token_limits", Handled),
    ("api_key_token_counters", Handled),
    ("api_key_usage_reservations", Handled),
    ("api_key_context_sources", Handled),
    ("domain_budgets", Handled),
    ("budgets", Handled),
    ("budget_windows", Handled),
    ("budget_window_models", Handled),
    ("budget_assignments", Handled),
    ("key_groups", Handled),
    ("key_group_members", Handled),
    ("group_model_permissions", Handled),
    ("model_combo_mappings", Handled),
    // Runtime state, caches and derived data the legacy server rebuilds.
    ("_omniroute_migrations", Dropped("legacy migration bookkeeping")),
    ("db_meta", Dropped("legacy database bookkeeping")),
    ("domain_lockout_state", Dropped("runtime lockout state")),
    ("domain_circuit_breakers", Dropped("runtime circuit breaker state")),
    ("connection_runtime_state", Dropped("runtime connection state")),
    ("exclusive_connection_leases", Dropped("runtime connection leases")),
    ("session_account_affinity", Dropped("runtime session affinity")),
    ("session_model_history", Dropped("runtime per-session model history")),
    ("combo_adaptation_state", Dropped("runtime combo adaptation state")),
    ("provider_quota_state", Dropped("runtime upstream quota state, refreshed from providers")),
    ("quota_consumption", Dropped("runtime sliding-window counters")),
    ("relay_rate_limits", Dropped("runtime relay rate counters")),
    ("budget_inflight", Dropped("runtime in-flight budget holds")),
    ("budget_inflight_scopes", Dropped("runtime in-flight budget holds")),
    ("login_lockouts", Dropped("runtime login lockouts")),
    ("agentic_conversations", Dropped("runtime conversation tracking")),
    ("conversation_turn_nodes", Dropped("runtime conversation tracking")),
    ("context_handoffs", Dropped("context-relay summaries of active sessions")),
    ("ccr_blocks", Dropped("CCR block store with a 24-hour TTL")),
    ("semantic_cache", Dropped("response cache")),
    ("reasoning_cache", Dropped("reasoning cache")),
    ("compression_cache_stats", Dropped("compression cache counters")),
    ("discovery_results", Dropped("provider discovery cache")),
    ("model_capabilities", Dropped("lazily discovered model capability cache")),
    ("radar_feed_cache", Dropped("Radar feed cache")),
    ("radar_referrals_cache", Dropped("Radar referral cache")),
    ("radar_offers_cache", Dropped("Radar offer cache")),
    ("radar_intel_cache", Dropped("Radar intel cache")),
    ("redrouter_cache_prefix_observations", Dropped("prompt-cache prefix telemetry")),
    ("redrouter_usage_windows", Dropped("usage-export watermarks of the legacy sinks")),
    ("memory_fts", Dropped("full-text index over memories")),
    ("memory_vec_meta", Dropped("vector index bookkeeping")),
    // Configuration and features without a native importer yet.
    ("redrouter_usage_sinks", Refused("usage sinks")),
    ("files", Refused("uploaded files")),
    ("domain_fallback_chains", Refused("per-model fallback chains")),
    ("batches", Refused("batch jobs")),
    ("batch_item_checkpoints", Refused("batch jobs")),
    ("video_jobs", Refused("video jobs")),
    ("webhooks", Refused("webhooks")),
    ("memories", Refused("memories")),
    ("skills", Refused("skills")),
    ("a2a_tasks", Refused("A2A tasks")),
    ("registered_keys", Refused("registered key provisioning")),
    ("provider_key_limits", Refused("registered key provisioning")),
    ("account_key_limits", Refused("registered key provisioning")),
    ("upstream_proxy_config", Refused("the CLIProxyAPI upstream proxy")),
    ("proxy_registry", Refused("the proxy registry")),
    ("proxy_assignments", Refused("the proxy registry")),
    ("proxy_scope_rotation", Refused("the proxy registry")),
    ("proxy_subscriptions", Refused("proxy subscriptions")),
    ("free_proxies", Refused("free proxies")),
    ("relay_tokens", Refused("relay tokens")),
    ("middleware_hooks", Refused("middleware hooks")),
    ("plugins", Refused("plugins")),
    ("eval_suites", Refused("evals")),
    ("eval_cases", Refused("evals")),
    ("eval_runs", Refused("evals")),
    ("compression_combo_assignments", Refused("prompt compression")),
    ("provider_plans", Refused("provider plans")),
    ("quota_pools", Refused("quota pools")),
    ("quota_allocations", Refused("quota pools")),
    ("quota_pool_connections", Refused("quota pools")),
    ("quota_allocation_model_caps", Refused("quota pools")),
    ("quota_schedules", Refused("quota schedules")),
    ("tier_config", Refused("tiers")),
    ("tier_assignments", Refused("tiers")),
    ("model_intelligence", Refused("model intelligence scores")),
    ("model_context_overrides", Refused("model context overrides")),
    ("model_capability_overrides", Refused("model capability overrides")),
    ("reasoning_routing_rules", Refused("reasoning routing rules")),
    ("auto_candidate_overrides", Refused("auto-combo candidate overrides")),
    ("routing_profiles", Refused("routing profiles")),
    ("routing_profile_bindings", Refused("routing profiles")),
    ("tenant_routing_policy", Refused("tenant routing policy")),
    ("tenant_profiles", Refused("tenant profiles")),
    ("tenant_users", Refused("tenant users")),
    ("tenant_invites", Refused("tenant invites")),
    ("tenant_shared_resources", Refused("tenant shared resources")),
    ("auth_mfa", Refused("multi-factor login")),
    ("cli_access_tokens", Refused("CLI access tokens")),
    ("command_code_auth_sessions", Refused("Command Code sign-in sessions")),
    ("cloud_agent_credentials", Refused("cloud agent credentials")),
    ("sync_tokens", Refused("sync tokens")),
    ("agent_bridge_state", Refused("the agent bridge")),
    ("agent_bridge_mappings", Refused("the agent bridge")),
    ("agent_bridge_bypass", Refused("the agent bridge")),
    ("inspector_custom_hosts", Refused("inspector hosts")),
    ("playground_presets", Refused("playground presets")),
    ("log_export_destinations", Refused("log export destinations")),
    ("radar_local_model_state", Refused("Radar local model overrides")),
    ("leaderboard", Refused("gamification")),
    ("user_levels", Refused("gamification")),
    ("badge_definitions", Refused("gamification")),
    ("user_badges", Refused("gamification")),
    ("token_ledger", Refused("gamification")),
    ("xp_action_counts", Refused("gamification")),
    ("invite_tokens", Refused("gamification invites")),
    ("community_servers", Refused("community servers")),
    // Seeded by a fresh install.
    (
        "version_manager",
        Seeded {
            feature: "managed CLI tools",
            seed: "status = 'not_installed' AND binary_path IS NULL AND api_key IS NULL AND management_key IS NULL AND COALESCE(auto_start, 0) = 0 AND pinned_version IS NULL AND config_overrides IS NULL",
        },
    ),
    (
        "compression_combos",
        Seeded {
            feature: "prompt compression",
            seed: "id = 'default-caveman' AND name = 'Standard Savings' AND description = 'Default RTK + Caveman compression pipeline' AND pipeline = '[{\"engine\":\"rtk\",\"intensity\":\"standard\"},{\"engine\":\"caveman\",\"intensity\":\"full\"}]' AND language_packs = '[\"en\"]' AND output_mode = 0 AND output_mode_intensity = 'full' AND is_default = 1",
        },
    ),
    (
        "quota_groups",
        Seeded {
            feature: "quota groups",
            seed: "id = 'group-demo' AND name = 'GroupDemo'",
        },
    ),
    (
        "radar_settings",
        Seeded {
            feature: "Radar",
            seed: "COALESCE(opt_in, 0) = 0 AND supporter_key_encrypted IS NULL",
        },
    ),
    (
        "jobs",
        Seeded {
            feature: "background jobs",
            seed: "(id = 'budget_reset' AND type = 'interval' AND cron IS NULL AND interval_ms = 600000 AND enabled = 1 AND env_flag IS NULL AND config = '{}') OR (id = 'warmup' AND type = 'cron' AND cron = '0 7 * * *' AND interval_ms IS NULL AND enabled = 0 AND env_flag = 'OMNIROUTE_WARMUP_ENABLED' AND config = '{\"timezone\":\"America/Los_Angeles\",\"envDefault\":false}') OR (id = 'token_health_check' AND type = 'interval' AND cron IS NULL AND interval_ms = 60000 AND enabled = 1 AND env_flag IS NULL AND config = '{}')",
        },
    ),
];

/// The inventory class of a legacy table, `None` when it is unknown.
pub fn class(table: &str) -> Option<TableClass> {
    if ARCHIVED.contains(&table) {
        return Some(Archived);
    }
    INVENTORY
        .iter()
        .find(|(name, _)| *name == table)
        .map(|(_, class)| *class)
}

/// Why a legacy `key_value` namespace is accepted or refused by the cutover.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NamespaceClass {
    /// An importer stage reads it and applies its own refusals.
    Handled,
    /// Runtime state, a cache or bookkeeping; dropped by design.
    Dropped(&'static str),
    /// Refused while it holds rows: the native daemon has no equivalent yet.
    Refused(&'static str),
    /// Seeded by a fresh install: refused for any row that is not a seed row.
    Seeded {
        feature: &'static str,
        rows: &'static [(&'static str, &'static str)],
    },
    /// Seeded bookkeeping: only these keys, with any value, are accepted.
    SeededKeys {
        feature: &'static str,
        keys: &'static [&'static str],
    },
}

const COMPRESSION_SEED: &[(&str, &str)] = &[
    ("enabled", "false"),
    ("defaultMode", "\"off\""),
    ("autoTriggerTokens", "0"),
    ("cacheMinutes", "5"),
    ("preserveSystemPrompt", "true"),
    ("comboOverrides", "{}"),
    ("cavemanConfig", "{\"enabled\":true,\"compressRoles\":[\"user\"],\"skipRules\":[],\"minMessageLength\":50,\"preservePatterns\":[]}"),
    ("mcpAccessibility", "{\"enabled\":true,\"maxTextChars\":50000,\"collapseThreshold\":30,\"collapseKeepHead\":10,\"collapseKeepTail\":5,\"minLengthToProcess\":2000}"),
    ("activeComboId", "null"),
];

const DATABASESETTINGS_SEED: &[(&str, &str)] = &[
    ("detailedLogsEnabled", "true"),
    ("callLogPipelineEnabled", "true"),
    ("maxDetailSizeKb", "500"),
    ("ringBufferSize", "1000"),
    ("autoBackupEnabled", "false"),
    ("autoBackupFrequency", "\"never\""),
    ("keepLastNBackups", "3"),
    ("semanticCacheEnabled", "true"),
    ("semanticCacheMaxSize", "100"),
    ("semanticCacheTTL", "1800000"),
    ("promptCacheEnabled", "true"),
    ("promptCacheStrategy", "\"auto\""),
    ("alwaysPreserveClientCache", "\"auto\""),
    ("quotaSnapshots", "90"),
    ("compressionAnalytics", "30"),
    ("mcpAudit", "30"),
    ("configAudit", "30"),
    ("a2aEvents", "30"),
    ("callLogs", "90"),
    ("usageHistory", "365"),
    ("memoryEntries", "180"),
    ("autoCleanupEnabled", "true"),
    ("aggregationEnabled", "false"),
    ("rawDataRetentionDays", "7"),
    ("granularity", "\"daily\""),
    ("autoVacuumMode", "\"INCREMENTAL\""),
    ("scheduledVacuum", "\"weekly\""),
    ("pageSize", "4096"),
    ("cacheSize", "16384"),
    ("mmapSize", "268435456"),
];

const NAMESPACES: &[(&str, NamespaceClass)] = &[
    ("settings", NamespaceClass::Handled),
    ("pricing", NamespaceClass::Handled),
    ("pricing_synced", NamespaceClass::Handled),
    ("models_dev_pricing", NamespaceClass::Handled),
    ("customModels", NamespaceClass::Handled),
    ("syncedAvailableModels", NamespaceClass::Handled),
    ("modelAliases", NamespaceClass::Handled),
    ("providerAliases", NamespaceClass::Handled),
    ("managedModelAliasNames", NamespaceClass::Handled),
    ("modelCompatOverrides", NamespaceClass::Handled),
    ("api_key_id_format", NamespaceClass::Handled),
    ("api_key_tags", NamespaceClass::Handled),
    ("api_key_usage_attributes", NamespaceClass::Handled),
    // Dashboard session signing and the key-checksum secret: imported keys
    // authenticate by their SHA-256 hash and the native API has no login.
    ("secrets", NamespaceClass::Dropped("legacy process secrets")),
    (
        "lkgp",
        NamespaceClass::Dropped("learned last-known-good route pins"),
    ),
    (
        "antigravityCreditBalance",
        NamespaceClass::Dropped("Antigravity credit balance cache"),
    ),
    (
        "gemini_thought_signatures",
        NamespaceClass::Dropped("Gemini thought signature cache"),
    ),
    (
        "models_dev_snapshot",
        NamespaceClass::Dropped("models.dev catalog cache"),
    ),
    (
        "pricing_sync_status",
        NamespaceClass::Dropped("pricing sync status"),
    ),
    (
        "providerLimitsCache",
        NamespaceClass::Dropped("provider limits cache"),
    ),
    (
        "remoteRouterCatalog",
        NamespaceClass::Dropped("remote router catalog cache"),
    ),
    (
        "ccDiscoveryMetrics",
        NamespaceClass::Dropped("Claude Code discovery metrics"),
    ),
    (
        "walMaintenance",
        NamespaceClass::Dropped("legacy WAL maintenance bookkeeping"),
    ),
    (
        "scheduler",
        NamespaceClass::Dropped("legacy vacuum scheduler bookkeeping"),
    ),
    (
        "friday_legacy",
        NamespaceClass::Dropped("v0.33 import bookkeeping"),
    ),
    (
        "dbBackup",
        NamespaceClass::Refused("database backup settings"),
    ),
    (
        "feature_flags",
        NamespaceClass::Refused("feature flag overrides"),
    ),
    (
        "proxyConfig",
        NamespaceClass::Refused("outbound proxy configuration"),
    ),
    ("ipFilter", NamespaceClass::Refused("IP filtering")),
    (
        "interception_rules",
        NamespaceClass::Refused("interception rules"),
    ),
    (
        "provider_param_filters",
        NamespaceClass::Refused("provider parameter filters"),
    ),
    ("serviceModels", NamespaceClass::Refused("service models")),
    ("mitmAlias", NamespaceClass::Refused("MITM aliases")),
    (
        "ccDiscoveryAliases",
        NamespaceClass::Refused("Claude Code discovery aliases"),
    ),
    ("conductor", NamespaceClass::Refused("the Conductor bridge")),
    (
        "functionalGatewayMirrors",
        NamespaceClass::Refused("functional gateway mirrors"),
    ),
    ("local_corpus", NamespaceClass::Refused("the local corpus")),
    ("notion", NamespaceClass::Refused("the Notion integration")),
    (
        "obsidian",
        NamespaceClass::Refused("the Obsidian integration"),
    ),
    (
        "compression",
        NamespaceClass::Seeded {
            feature: "prompt compression settings",
            rows: COMPRESSION_SEED,
        },
    ),
    (
        "databaseSettings",
        NamespaceClass::Seeded {
            feature: "database settings",
            rows: DATABASESETTINGS_SEED,
        },
    ),
    (
        "apiKeySelfService",
        NamespaceClass::SeededKeys {
            feature: "API key self-service bookkeeping",
            keys: &["usageScopesBackfilled"],
        },
    ),
];

/// The inventory class of a legacy `key_value` namespace, `None` when unknown.
pub fn namespace_class(namespace: &str) -> Option<NamespaceClass> {
    NAMESPACES
        .iter()
        .find(|(name, _)| *name == namespace)
        .map(|(_, class)| *class)
}

async fn namespace_refusal(db: &mut SqliteConnection) -> Result<Option<String>, &'static str> {
    let namespaces: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT namespace FROM key_value ORDER BY namespace")
            .fetch_all(&mut *db)
            .await
            .map_err(|_| "cannot inspect legacy key_value namespaces")?;
    for namespace in namespaces {
        let rows: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT key, value FROM key_value WHERE namespace = ?")
                .bind(&namespace)
                .fetch_all(&mut *db)
                .await
                .map_err(|_| "cannot inspect legacy key_value rows")?;
        let refusal = match namespace_class(&namespace) {
            Some(NamespaceClass::Handled | NamespaceClass::Dropped(_)) => None,
            Some(NamespaceClass::Refused(feature)) => (!rows.is_empty()).then(|| {
                format!("legacy {feature} (key_value namespace {namespace}) have no native importer yet")
            }),
            Some(NamespaceClass::Seeded { feature, rows: seed }) => rows
                .iter()
                .any(|(key, value)| {
                    !seed
                        .iter()
                        .any(|(seed_key, seed_value)| key == seed_key && value.as_deref() == Some(*seed_value))
                })
                .then(|| format!("legacy {feature} (key_value namespace {namespace}) were configured and have no native importer yet")),
            Some(NamespaceClass::SeededKeys { feature, keys }) => rows
                .iter()
                .any(|(key, _)| !keys.contains(&key.as_str()))
                .then(|| format!("legacy {feature} (key_value namespace {namespace}) hold rows without a native importer")),
            None => Some(format!(
                "legacy key_value namespace {namespace} is not in the migration inventory"
            )),
        };
        if refusal.is_some() {
            return Ok(refusal);
        }
    }
    Ok(None)
}

fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// The first legacy table whose rows the cutover cannot carry, with the
/// reason; `None` when every table with rows has a decision that accepts it.
pub async fn refusal(source: &Path) -> Result<Option<String>, &'static str> {
    let mut db = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(source).read_only(true),
    )
    .await
    .map_err(|_| "cannot open legacy database")?;
    let result = async {
        let objects: Vec<(String, String)> = sqlx::query_as(
            "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .fetch_all(&mut db)
        .await
        .map_err(|_| "cannot inspect legacy tables")?;
        let virtual_tables: Vec<&str> = objects
            .iter()
            .filter(|(_, sql)| sql.trim_start().to_ascii_uppercase().starts_with("CREATE VIRTUAL TABLE"))
            .map(|(name, _)| name.as_str())
            .collect();
        for (table, _) in &objects {
            // FTS shadow tables belong to their virtual table.
            if virtual_tables
                .iter()
                .any(|parent| table != parent && table.starts_with(&format!("{parent}_")))
            {
                continue;
            }
            let class = class(table);
            if table == "key_value" {
                if let Some(refusal) = namespace_refusal(&mut db).await? {
                    return Ok(Some(refusal));
                }
            }
            let filter = match class {
                Some(Handled | Archived | Dropped(_)) => continue,
                Some(Seeded { seed, .. }) => format!(" WHERE NOT ({seed})"),
                Some(Refused(_)) | None => String::new(),
            };
            let offending: i64 = sqlx::query_scalar(&format!(
                "SELECT EXISTS(SELECT 1 FROM {}{filter})",
                ident(table)
            ))
            .fetch_one(&mut db)
            .await
            .map_err(|_| "cannot inspect legacy rows")?;
            if offending == 0 {
                continue;
            }
            return Ok(Some(match class {
                Some(Refused(feature)) => {
                    format!("legacy {feature} ({table}) have no native importer yet")
                }
                Some(Seeded { feature, .. }) => {
                    format!("legacy {feature} ({table}) were configured and have no native importer yet")
                }
                _ => format!("legacy table {table} is not in the migration inventory"),
            }));
        }
        Ok(None)
    }
    .await;
    let _ = db.close().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_table_has_one_decision() {
        let mut names: Vec<&str> = INVENTORY.iter().map(|(name, _)| *name).collect();
        names.extend(ARCHIVED);
        let total = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), total, "a table is listed twice");
        // Every table a fresh legacy install creates is in the inventory.
        let mut seen = 0;
        let fixture = include_str!("../tests/fixtures/legacy_reference/legacy_reference.sql");
        for line in fixture.lines() {
            let Some(rest) = line
                .strip_prefix("CREATE TABLE ")
                .or_else(|| line.strip_prefix("CREATE VIRTUAL TABLE "))
            else {
                continue;
            };
            let rest = rest.strip_prefix("IF NOT EXISTS ").unwrap_or(rest);
            let name: String = rest
                .trim_start_matches('"')
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if name.starts_with("memory_fts_") {
                continue;
            }
            assert!(class(&name).is_some(), "{name} has no cutover decision");
            seen += 1;
        }
        assert!(seen >= 150, "only {seen} fixture tables parsed");
    }
}
