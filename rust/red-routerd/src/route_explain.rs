//! Route explanation of one logged request (legacy `src/lib/usage/routeExplain.ts`,
//! `GET /api/usage/route-explain/[id]`).
//!
//! The legacy inferred the fallback chain from call logs near the selected one
//! in time; here the attempts of a request share a `request_id`, so the chain
//! is the request's own attempts in order. Score, factors, evidence and
//! recommendations follow the legacy heuristics. The legacy decision replay
//! (a recompute through the combo scoring inspector) and the target resilience
//! snapshot are not part of this explanation.
use crate::request_log::Entry;
use serde::Serialize;

/// Window around the selected attempt that feeds the target's recent stats.
pub(crate) const STATS_WINDOW_MS: i64 = 15 * 60 * 1000;
const HIGH_LATENCY_MS: i64 = 15_000;
const OK_LATENCY_MS: i64 = 5_000;

/// The combo a request named, as configured now.
pub(crate) struct ComboRef {
    pub id: String,
    pub strategy: String,
    pub fallback: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct Combo {
    pub id: String,
    pub strategy: String,
    pub fallback: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct Request {
    pub request_id: String,
    pub created_at_unix_ms: i64,
    pub protocol: String,
    pub requested_model: String,
    pub tenant_id: String,
    pub key_id: String,
    pub stream: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct Target {
    pub id: String,
    pub attempt: i64,
    pub created_at_unix_ms: i64,
    pub status: i64,
    pub error: Option<String>,
    pub provider: String,
    pub provider_id: String,
    pub model: String,
    pub duration_ms: i64,
    pub ttft_ms: Option<i64>,
    pub tokens_input: i64,
    pub tokens_output: i64,
    pub amount_usd: Option<f64>,
    /// `selected`, `fallback` (failed and moved past) or `related`.
    pub outcome: &'static str,
    pub reason: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct TargetStats {
    pub sample_size: usize,
    pub success_rate: i64,
    pub avg_latency_ms: i64,
    pub last_status: Option<&'static str>,
    pub last_used_at_unix_ms: Option<i64>,
}

#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct Factor {
    pub name: &'static str,
    pub value: String,
    /// `positive`, `warning`, `negative` or `neutral`.
    pub status: &'static str,
    pub weight: f64,
    pub contribution: f64,
    pub details: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct Evidence {
    pub label: &'static str,
    pub value: String,
    pub tone: &'static str,
}

#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct Explanation {
    pub request_id: String,
    pub generated_at_unix_ms: i64,
    /// `combo` or `direct`.
    pub route_type: &'static str,
    /// `medium` or `low`: no pipeline payloads are stored, which the legacy
    /// required for `high`.
    pub confidence: &'static str,
    pub summary: String,
    pub combo: Option<Combo>,
    pub request: Request,
    pub selected_target: Target,
    pub attempts: Vec<Target>,
    pub fallbacks_triggered: Vec<Target>,
    pub target_stats: TargetStats,
    pub score: f64,
    pub factors: Vec<Factor>,
    pub evidence: Vec<Evidence>,
    pub recommendations: Vec<&'static str>,
    pub limitations: Vec<&'static str>,
}

/// Legacy `isSuccessStatus` (2xx and 3xx), and no failure label on the row.
fn succeeded(entry: &Entry) -> bool {
    (200..400).contains(&entry.status) && entry.error.is_none()
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

/// The served attempt of a request's attempts in any order: the last that
/// succeeded, else the last one tried.
pub(crate) fn served_attempt(attempts: &[Entry]) -> Option<&Entry> {
    attempts
        .iter()
        .filter(|entry| succeeded(entry))
        .max_by_key(|entry| entry.attempt)
        .or_else(|| attempts.iter().max_by_key(|entry| entry.attempt))
}

/// The served attempt: the last that succeeded, else the last one tried.
fn selected_index(attempts: &[Entry]) -> Option<usize> {
    attempts
        .iter()
        .rposition(succeeded)
        .or_else(|| attempts.len().checked_sub(1))
}

fn target(entry: &Entry, selected: bool, request_failed: bool) -> Target {
    let ok = succeeded(entry);
    let (outcome, reason) = if selected {
        (
            "selected",
            if request_failed {
                "Last attempt of a request that no target served.".to_owned()
            } else {
                "Served this request.".to_owned()
            },
        )
    } else if ok {
        (
            "related",
            "Succeeded, but another attempt answered the request.".to_owned(),
        )
    } else {
        (
            "fallback",
            format!(
                "Failed with HTTP {}{}; the router moved to the next target.",
                entry.status,
                entry
                    .error
                    .as_deref()
                    .map(|error| format!(" ({error})"))
                    .unwrap_or_default()
            ),
        )
    };
    Target {
        id: entry.id.clone(),
        attempt: entry.attempt,
        created_at_unix_ms: entry.created_at_unix_ms,
        status: entry.status,
        error: entry.error.clone(),
        provider: entry.provider.clone(),
        provider_id: entry.provider_id.clone(),
        model: entry.model.clone(),
        duration_ms: entry.duration_ms,
        ttft_ms: entry.ttft_ms,
        tokens_input: entry.usage.as_ref().map_or(0, |usage| usage.tokens_input),
        tokens_output: entry.usage.as_ref().map_or(0, |usage| usage.tokens_output),
        amount_usd: entry.usage.as_ref().and_then(|usage| usage.amount_usd),
        outcome,
        reason,
    }
}

/// Legacy `buildTargetStats`: the attempts on the same account and model,
/// or the selected attempt alone when there are none.
fn target_stats(selected: &Entry, comparable: &[Entry]) -> TargetStats {
    let matching: Vec<&Entry> = comparable
        .iter()
        .filter(|entry| entry.provider_id == selected.provider_id && entry.model == selected.model)
        .collect();
    let sample = if matching.is_empty() {
        vec![selected]
    } else {
        matching
    };
    let size = sample.len();
    let successes = sample.iter().filter(|entry| succeeded(entry)).count();
    let latency: i64 = sample.iter().map(|entry| entry.duration_ms).sum();
    let latest = sample
        .iter()
        .max_by_key(|entry| (entry.created_at_unix_ms, entry.id.as_str()));
    // Legacy Math.round of the rate and the mean; the sample is never empty.
    let size_f64 = size.max(1) as f64;
    TargetStats {
        sample_size: size,
        success_rate: (successes as f64 / size_f64 * 100.0).round() as i64,
        avg_latency_ms: (latency as f64 / size_f64).round() as i64,
        last_status: latest.map(|entry| if succeeded(entry) { "ok" } else { "error" }),
        last_used_at_unix_ms: latest.map(|entry| entry.created_at_unix_ms),
    }
}

/// Legacy `calculateScore` (no semantic cache, so the cache term is 0.05).
fn score(selected: &Entry, stats: &TargetStats) -> f64 {
    let status = if succeeded(selected) { 0.4 } else { 0.0 };
    let latency = if selected.duration_ms > 0 {
        (0.25 - selected.duration_ms.min(HIGH_LATENCY_MS) as f64 / 60_000.0).max(0.0)
    } else {
        0.1
    };
    let history = if stats.sample_size > 0 {
        stats.success_rate as f64 / 100.0 * 0.25
    } else {
        0.1
    };
    round3((status + latency + history + 0.05).min(1.0))
}

fn tokens_summary(target: &Target) -> String {
    format!("{} in · {} out", target.tokens_input, target.tokens_output)
}

fn health_tone(stats: &TargetStats) -> &'static str {
    if stats.success_rate >= 90 {
        "positive"
    } else if stats.success_rate >= 60 {
        "warning"
    } else {
        "negative"
    }
}

/// Legacy `buildFactors`.
fn factors(selected: &Target, combo: Option<&Combo>, stats: &TargetStats) -> Vec<Factor> {
    let ok = (200..400).contains(&selected.status) && selected.error.is_none();
    let latency = selected.duration_ms;
    let resolved = !selected.provider_id.is_empty() && !selected.model.is_empty();
    vec![
        Factor {
            name: if combo.is_some() {
                "Combo routing"
            } else {
                "Direct routing"
            },
            value: combo.map_or_else(
                || "Direct provider request".to_owned(),
                |combo| combo.id.clone(),
            ),
            status: if combo.is_some() {
                "positive"
            } else {
                "neutral"
            },
            weight: 0.25,
            contribution: if combo.is_some() { 0.25 } else { 0.15 },
            details: combo.map_or_else(
                || {
                    "The requested model is not a combo, so the request was routed directly."
                        .to_owned()
                },
                |combo| {
                    format!(
                        "Request matched combo {} ({} strategy).",
                        combo.id, combo.strategy
                    )
                },
            ),
        },
        Factor {
            name: "Provider target",
            value: if resolved {
                format!("{} / {}", selected.provider_id, selected.model)
            } else {
                "unknown".to_owned()
            },
            status: if resolved { "positive" } else { "warning" },
            weight: 0.2,
            contribution: if resolved { 0.2 } else { 0.08 },
            details: format!(
                "Selected account {} with resolved model {}.",
                if selected.provider_id.is_empty() {
                    "unknown"
                } else {
                    &selected.provider_id
                },
                if selected.model.is_empty() {
                    "unknown"
                } else {
                    &selected.model
                }
            ),
        },
        Factor {
            name: "Runtime health",
            value: format!("{}% recent success", stats.success_rate),
            status: health_tone(stats),
            weight: 0.2,
            contribution: round3(stats.success_rate as f64 / 100.0 * 0.2),
            details: format!(
                "{} comparable attempts within 15 minutes, average latency {}ms.",
                stats.sample_size, stats.avg_latency_ms
            ),
        },
        Factor {
            name: "Request outcome",
            value: format!("HTTP {}", selected.status),
            status: if ok { "positive" } else { "negative" },
            weight: 0.2,
            contribution: if ok { 0.2 } else { 0.0 },
            details: if ok {
                "The selected target completed successfully.".to_owned()
            } else {
                selected.error.clone().unwrap_or_else(|| {
                    "The selected target failed or did not return a successful status.".to_owned()
                })
            },
        },
        Factor {
            name: "Latency",
            value: format!("{latency}ms"),
            status: if latency <= OK_LATENCY_MS {
                "positive"
            } else if latency <= HIGH_LATENCY_MS {
                "warning"
            } else {
                "negative"
            },
            weight: 0.1,
            contribution: if latency <= OK_LATENCY_MS {
                0.1
            } else if latency <= HIGH_LATENCY_MS {
                0.05
            } else {
                0.02
            },
            details: "Measured duration of the selected attempt, to the end of its response body."
                .to_owned(),
        },
        Factor {
            name: "Cache and tokens",
            value: format!("upstream · {}", tokens_summary(selected)),
            status: "neutral",
            weight: 0.05,
            contribution: 0.025,
            details:
                "Shows whether RedRouter cache or compression affected cost/latency for this route."
                    .to_owned(),
        },
    ]
}

/// Legacy `buildRecommendations`.
fn recommendations(
    selected: &Target,
    served: bool,
    combo: Option<&Combo>,
    stats: &TargetStats,
) -> Vec<&'static str> {
    let mut out = Vec::new();
    if !served {
        out.push("Inspect the provider error and consider moving this target later in the combo until it recovers.");
    }
    if stats.sample_size >= 3 && stats.success_rate < 80 {
        out.push("Recent success rate is low; review account cooldowns, model lockouts, or provider circuit breaker state.");
    }
    if selected.duration_ms > HIGH_LATENCY_MS {
        out.push("Latency is high; compare this target with a faster provider in Combo Health before increasing traffic.");
    }
    if combo.is_none() {
        out.push(
            "Use a combo when you want fallback visibility and multi-provider route explanations.",
        );
    }
    if out.is_empty() {
        out.push("Route looks healthy. Keep monitoring target success rate and quota pressure in Combo Health.");
    }
    out
}

/// Explain one request from its attempts (any order) and the attempts near
/// the served one (`comparable`, for the target's recent stats). `None` when
/// the request has no attempts.
pub(crate) fn explain(
    mut attempts: Vec<Entry>,
    comparable: &[Entry],
    combo: Option<ComboRef>,
    now_unix_ms: i64,
) -> Option<Explanation> {
    attempts.sort_by_key(|entry| entry.attempt);
    let selected_at = selected_index(&attempts)?;
    let served = succeeded(&attempts[selected_at]);
    let first = &attempts[0];
    let request = Request {
        request_id: first.request_id.clone(),
        created_at_unix_ms: first.created_at_unix_ms,
        protocol: first.protocol.clone(),
        requested_model: first.requested_model.clone(),
        tenant_id: first.tenant_id.clone(),
        key_id: first.key_id.clone(),
        stream: first.stream,
    };
    let stats = target_stats(&attempts[selected_at], comparable);
    let score = score(&attempts[selected_at], &stats);
    let targets: Vec<Target> = attempts
        .iter()
        .enumerate()
        .map(|(index, entry)| target(entry, index == selected_at, !served))
        .collect();
    let fallbacks_triggered: Vec<Target> = attempts
        .iter()
        .enumerate()
        .filter(|(index, entry)| *index < selected_at && !succeeded(entry))
        .map(|(_, entry)| target(entry, false, !served))
        .collect();
    let selected_target = target(&attempts[selected_at], true, !served);
    let combo = combo.map(|combo| Combo {
        id: combo.id,
        strategy: combo.strategy,
        fallback: combo.fallback,
    });
    let factors = factors(&selected_target, combo.as_ref(), &stats);
    let destination = format!(
        "{}/{}",
        if selected_target.provider_id.is_empty() {
            "unknown"
        } else {
            &selected_target.provider_id
        },
        if selected_target.model.is_empty() {
            "unknown"
        } else {
            &selected_target.model
        }
    );
    let summary = match (&combo, served) {
        (Some(combo), true) => format!(
            "Request {} was routed through combo {} to {destination}.",
            request.request_id, combo.id
        ),
        (None, true) => format!(
            "Request {} was routed directly to {destination}.",
            request.request_id
        ),
        (Some(combo), false) => format!(
            "Request {} went through combo {} and no target served it; the last attempt was {destination}.",
            request.request_id, combo.id
        ),
        (None, false) => format!(
            "Request {} was sent directly to {destination} and failed.",
            request.request_id
        ),
    };
    let evidence = vec![
        Evidence {
            label: "Requested model",
            value: request.requested_model.clone(),
            tone: "neutral",
        },
        Evidence {
            label: "Resolved model",
            value: if selected_target.model.is_empty() {
                "n/a".to_owned()
            } else {
                selected_target.model.clone()
            },
            tone: if selected_target.model.is_empty() {
                "warning"
            } else {
                "positive"
            },
        },
        Evidence {
            label: "Provider",
            value: if selected_target.provider.is_empty() {
                "n/a".to_owned()
            } else {
                selected_target.provider.clone()
            },
            tone: if selected_target.provider.is_empty() {
                "warning"
            } else {
                "positive"
            },
        },
        Evidence {
            label: "Combo",
            value: combo
                .as_ref()
                .map_or_else(|| "Direct".to_owned(), |combo| combo.id.clone()),
            tone: if combo.is_some() {
                "positive"
            } else {
                "neutral"
            },
        },
        Evidence {
            label: "Recent target success",
            value: format!("{}% over {} samples", stats.success_rate, stats.sample_size),
            tone: health_tone(&stats),
        },
        Evidence {
            label: "Protocol",
            value: request.protocol.clone(),
            tone: "neutral",
        },
    ];
    let recommendations = recommendations(&selected_target, served, combo.as_ref(), &stats);
    let mut limitations = vec![
        "Request and response bodies are not stored, so pipeline payloads are not part of this explanation.",
        "The combo shown is the current configuration of the requested model, not a snapshot from the time of the request.",
    ];
    if combo.is_none() {
        limitations.push("Direct requests do not include combo fallback ordering metadata.");
    }
    Some(Explanation {
        request_id: request.request_id.clone(),
        generated_at_unix_ms: now_unix_ms,
        route_type: if combo.is_some() { "combo" } else { "direct" },
        confidence: if combo.is_some() || attempts.len() > 1 {
            "medium"
        } else {
            "low"
        },
        summary,
        combo,
        request,
        selected_target,
        attempts: targets,
        fallbacks_triggered,
        target_stats: stats,
        score,
        factors,
        evidence,
        recommendations,
        limitations,
    })
}

/// The request id of a request or attempt id (`rq_…` or `rq_…-N`).
pub(crate) fn request_id_of(id: &str) -> &str {
    match id.rsplit_once('-') {
        Some((request, attempt))
            if !attempt.is_empty() && attempt.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            request
        }
        _ => id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::request_log::Usage;

    fn entry(attempt: i64, provider_id: &str, status: i64, error: Option<&str>) -> Entry {
        Entry {
            id: format!("rq_a-{attempt}"),
            created_at_unix_ms: 1_000 + attempt,
            request_id: "rq_a".to_owned(),
            attempt,
            tenant_id: "red".to_owned(),
            key_id: "key".to_owned(),
            protocol: "chat".to_owned(),
            requested_model: "combo-a".to_owned(),
            model: "m".to_owned(),
            provider: "openai-compatible".to_owned(),
            provider_id: provider_id.to_owned(),
            status,
            error: error.map(str::to_owned),
            duration_ms: 1_200,
            ttft_ms: None,
            stream: false,
            usage: (status == 200).then_some(Usage {
                tokens_input: 3,
                tokens_output: 2,
                tokens_cache_read: 0,
                tokens_cache_creation: 0,
                tokens_reasoning: 0,
                amount_usd: Some(0.5),
            }),
        }
    }

    fn combo() -> Option<ComboRef> {
        Some(ComboRef {
            id: "combo-a".to_owned(),
            strategy: "priority".to_owned(),
            fallback: true,
        })
    }

    #[test]
    fn the_fallback_chain_is_the_requests_own_attempts() {
        let attempts = vec![
            entry(1, "good", 200, None),
            entry(0, "bad", 503, Some("upstream_error")),
        ];
        let explanation = explain(attempts, &[], combo(), 9).unwrap();
        assert_eq!(explanation.route_type, "combo");
        assert_eq!(explanation.confidence, "medium");
        assert_eq!(
            explanation.summary,
            "Request rq_a was routed through combo combo-a to good/m."
        );
        assert_eq!(explanation.selected_target.provider_id, "good");
        assert_eq!(explanation.selected_target.tokens_input, 3);
        assert_eq!(explanation.selected_target.amount_usd, Some(0.5));
        let outcomes: Vec<_> = explanation.attempts.iter().map(|t| t.outcome).collect();
        assert_eq!(outcomes, ["fallback", "selected"]);
        assert_eq!(explanation.fallbacks_triggered.len(), 1);
        assert_eq!(
            explanation.fallbacks_triggered[0].reason,
            "Failed with HTTP 503 (upstream_error); the router moved to the next target."
        );
        // Only the selected attempt is a sample: 100% success.
        assert_eq!(explanation.target_stats.sample_size, 1);
        assert_eq!(explanation.target_stats.success_rate, 100);
        // Legacy score: 0.4 status + (0.25 - 1200/60000) latency + 0.25 history + 0.05.
        assert_eq!(explanation.score, 0.93);
        assert_eq!(explanation.factors.len(), 6);
        assert_eq!(explanation.factors[0].name, "Combo routing");
        assert_eq!(
            explanation.recommendations,
            ["Route looks healthy. Keep monitoring target success rate and quota pressure in Combo Health."]
        );
    }

    #[test]
    fn a_request_no_target_served_selects_its_last_attempt() {
        let attempts = vec![
            entry(0, "bad", 503, Some("upstream_error")),
            entry(1, "worse", 429, Some("rate_limited")),
        ];
        let explanation = explain(attempts, &[], None, 9).unwrap();
        assert_eq!(explanation.route_type, "direct");
        assert_eq!(explanation.selected_target.provider_id, "worse");
        assert_eq!(explanation.fallbacks_triggered.len(), 1);
        assert_eq!(explanation.factors[3].status, "negative");
        assert_eq!(explanation.factors[3].details, "rate_limited");
        assert!(explanation.recommendations[0].starts_with("Inspect the provider error"));
        assert!(explanation.recommendations.contains(
            &"Use a combo when you want fallback visibility and multi-provider route explanations."
        ));
        assert_eq!(
            explanation.summary,
            "Request rq_a was sent directly to worse/m and failed."
        );
        assert!(explain(Vec::new(), &[], None, 9).is_none());
    }

    #[test]
    fn recent_stats_use_the_same_account_and_model() {
        let selected = entry(0, "good", 200, None);
        let mut slow = entry(5, "good", 500, Some("upstream_error"));
        slow.duration_ms = 3_000;
        let other_model = Entry {
            model: "other".to_owned(),
            ..entry(6, "good", 500, None)
        };
        let comparable = vec![
            selected.clone(),
            slow,
            entry(7, "good", 200, None),
            other_model,
            entry(8, "elsewhere", 500, None),
        ];
        let explanation = explain(vec![selected], &comparable, combo(), 9).unwrap();
        let stats = &explanation.target_stats;
        assert_eq!(stats.sample_size, 3);
        assert_eq!(stats.success_rate, 67);
        assert_eq!(stats.avg_latency_ms, 1_800);
        assert_eq!(stats.last_status, Some("ok"));
        assert_eq!(stats.last_used_at_unix_ms, Some(1_007));
        assert_eq!(explanation.factors[2].status, "warning");
    }

    #[test]
    fn attempt_ids_resolve_to_their_request() {
        assert_eq!(request_id_of("rq_abc-3"), "rq_abc");
        assert_eq!(request_id_of("rq_abc"), "rq_abc");
        assert_eq!(request_id_of("rq_abc-"), "rq_abc-");
        assert_eq!(request_id_of("rq-x"), "rq-x");
    }
}
