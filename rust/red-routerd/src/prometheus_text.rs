//! Prometheus text exposition format v0.0.4, ported from the legacy
//! `src/lib/metrics/prometheusText.ts`. Pure: plain data in, text out.

/// Legacy `PROMETHEUS_CONTENT_TYPE`.
pub const PROMETHEUS_CONTENT_TYPE: &str = "text/plain; version=0.0.4; charset=utf-8";

/// Legacy `REQUEST_DURATION_BUCKETS_SECONDS`; `+Inf` is appended on render.
pub const REQUEST_DURATION_BUCKETS_SECONDS: [f64; 10] =
    [0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0];

/// Legacy `CIRCUIT_BREAKER_STATES`.
pub const CIRCUIT_BREAKER_STATES: [&str; 4] = ["CLOSED", "DEGRADED", "OPEN", "HALF_OPEN"];

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestRow {
    pub provider: String,
    pub model: String,
    pub status_class: String,
    pub count: f64,
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct TokenRow {
    pub provider: String,
    pub model: String,
    /// `input`, `output`, `cache_read` or `cache_write`.
    pub direction: String,
    pub count: f64,
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct CostRow {
    pub provider: String,
    pub model: String,
    pub value: f64,
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyRow {
    pub provider: String,
    pub model: String,
    /// Cumulative counts for each [`REQUEST_DURATION_BUCKETS_SECONDS`] bound.
    pub buckets: Vec<f64>,
    pub sum_seconds: f64,
    pub count: f64,
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct BreakerRow {
    pub provider: String,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct ConnectionRow {
    pub provider: String,
    pub status: String,
    pub count: f64,
}

/// Legacy `MetricsSnapshot`.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    pub requests: Vec<RequestRow>,
    pub tokens: Vec<TokenRow>,
    pub cost_usd: Vec<CostRow>,
    pub latency: Vec<LatencyRow>,
    pub breakers: Vec<BreakerRow>,
    pub connections: Vec<ConnectionRow>,
    pub version: String,
    pub uptime_seconds: f64,
}

/// Legacy `escapeLabelValue`: backslash, double quote and newline escaped.
pub fn escape_label_value(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

/// Legacy `escapeHelp`: backslash and newline escaped.
pub fn escape_help(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\n', "\\n")
}

/// Legacy `formatValue`: JavaScript `String(number)` with Prometheus infinities.
pub fn format_value(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value == f64::INFINITY {
        return "+Inf".to_owned();
    }
    if value == f64::NEG_INFINITY {
        return "-Inf".to_owned();
    }
    js_number(value)
}

/// JavaScript `Number.prototype.toString()` for a finite number.
fn js_number(value: f64) -> String {
    if value == 0.0 {
        return "0".to_owned();
    }
    let magnitude = value.abs();
    if (1e-6..1e21).contains(&magnitude) {
        // Shortest round-trip digits, never in exponent form in this range.
        let text = format!("{value}");
        return text;
    }
    // Exponent form: shortest digits, JavaScript style `1e+21` / `1.5e-7`.
    let text = format!("{value:e}");
    let (mantissa, exponent) = text.split_once('e').expect("exponent form");
    let exponent: i32 = exponent.parse().expect("exponent");
    let sign = if exponent < 0 { '-' } else { '+' };
    format!("{mantissa}e{sign}{}", exponent.abs())
}

fn labels(pairs: &[(&str, &str)]) -> String {
    if pairs.is_empty() {
        return String::new();
    }
    let joined = pairs
        .iter()
        .map(|(name, value)| format!("{name}=\"{}\"", escape_label_value(value)))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{joined}}}")
}

fn header(lines: &mut Vec<String>, name: &str, kind: &str, help: &str) {
    lines.push(format!("# HELP {name} {}", escape_help(help)));
    lines.push(format!("# TYPE {name} {kind}"));
}

fn sample(lines: &mut Vec<String>, name: &str, pairs: &[(&str, &str)], value: f64) {
    lines.push(format!("{name}{} {}", labels(pairs), format_value(value)));
}

/// Legacy `renderPrometheusText`: every family is emitted (HELP and TYPE)
/// even without samples.
pub fn render_prometheus_text(snapshot: &MetricsSnapshot) -> String {
    let mut lines = Vec::new();
    let lines = &mut lines;

    header(
        lines,
        "redrouter_requests_total",
        "counter",
        "Completed requests by provider, model and HTTP status class.",
    );
    for row in &snapshot.requests {
        sample(
            lines,
            "redrouter_requests_total",
            &[
                ("provider", &row.provider),
                ("model", &row.model),
                ("status_class", &row.status_class),
            ],
            row.count,
        );
    }

    header(
        lines,
        "redrouter_tokens_total",
        "counter",
        "Tokens processed by provider, model and direction (input, output, cache_read, cache_write).",
    );
    for row in &snapshot.tokens {
        sample(
            lines,
            "redrouter_tokens_total",
            &[
                ("provider", &row.provider),
                ("model", &row.model),
                ("direction", &row.direction),
            ],
            row.count,
        );
    }

    header(
        lines,
        "redrouter_cost_usd_total",
        "counter",
        "Priced request cost in US dollars by provider and model.",
    );
    for row in &snapshot.cost_usd {
        sample(
            lines,
            "redrouter_cost_usd_total",
            &[("provider", &row.provider), ("model", &row.model)],
            row.value,
        );
    }

    header(
        lines,
        "redrouter_request_duration_seconds",
        "histogram",
        "Request duration in seconds by provider and model.",
    );
    for row in &snapshot.latency {
        for (index, bound) in REQUEST_DURATION_BUCKETS_SECONDS.iter().enumerate() {
            let bound = js_number(*bound);
            sample(
                lines,
                "redrouter_request_duration_seconds_bucket",
                &[
                    ("provider", &row.provider),
                    ("model", &row.model),
                    ("le", &bound),
                ],
                row.buckets.get(index).copied().unwrap_or(0.0),
            );
        }
        sample(
            lines,
            "redrouter_request_duration_seconds_bucket",
            &[
                ("provider", &row.provider),
                ("model", &row.model),
                ("le", "+Inf"),
            ],
            row.count,
        );
        sample(
            lines,
            "redrouter_request_duration_seconds_sum",
            &[("provider", &row.provider), ("model", &row.model)],
            row.sum_seconds,
        );
        sample(
            lines,
            "redrouter_request_duration_seconds_count",
            &[("provider", &row.provider), ("model", &row.model)],
            row.count,
        );
    }

    header(
        lines,
        "redrouter_circuit_breaker_state",
        "gauge",
        "Provider circuit breaker state: 1 for the current state, 0 for the others.",
    );
    for row in &snapshot.breakers {
        for state in CIRCUIT_BREAKER_STATES {
            sample(
                lines,
                "redrouter_circuit_breaker_state",
                &[("provider", &row.provider), ("state", state)],
                if row.state == state { 1.0 } else { 0.0 },
            );
        }
    }

    header(
        lines,
        "redrouter_connections",
        "gauge",
        "Provider connections by provider and status (active, unavailable, disabled).",
    );
    for row in &snapshot.connections {
        sample(
            lines,
            "redrouter_connections",
            &[("provider", &row.provider), ("status", &row.status)],
            row.count,
        );
    }

    header(
        lines,
        "redrouter_build_info",
        "gauge",
        "Build information; the value is always 1.",
    );
    sample(
        lines,
        "redrouter_build_info",
        &[("version", &snapshot.version)],
        1.0,
    );

    header(
        lines,
        "redrouter_uptime_seconds",
        "gauge",
        "Seconds since the server process started.",
    );
    sample(
        lines,
        "redrouter_uptime_seconds",
        &[],
        snapshot.uptime_seconds,
    );

    format!("{}\n", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Text the legacy renderer produced for the same snapshots
    /// (`prometheus_text_oracle.json`, generated with Node).
    #[test]
    fn rendering_matches_the_legacy_implementation() {
        let oracle: Vec<(MetricsSnapshot, String)> =
            serde_json::from_str(include_str!("prometheus_text_oracle.json")).unwrap();
        assert!(!oracle.is_empty());
        for (snapshot, expected) in &oracle {
            assert_eq!(render_prometheus_text(snapshot), *expected);
        }
    }

    #[test]
    fn values_format_like_javascript() {
        for (value, expected) in [
            (0.0, "0"),
            (1.0, "1"),
            (0.25, "0.25"),
            (12.5, "12.5"),
            (1e21, "1e+21"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (123456789.0, "123456789"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "+Inf"),
            (f64::NEG_INFINITY, "-Inf"),
            (-2.5, "-2.5"),
        ] {
            assert_eq!(format_value(value), expected, "{value}");
        }
        assert_eq!(escape_label_value("a\\b\"c\nd"), "a\\\\b\\\"c\\nd");
        assert_eq!(escape_help("a\\b\"c\nd"), "a\\\\b\"c\\nd");
    }
}
