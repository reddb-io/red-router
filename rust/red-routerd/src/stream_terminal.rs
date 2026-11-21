//! Stream terminal detection, ported from the legacy `utils/streamTerminal.ts`
//! (`isStreamTerminal`, `requiresStreamTerminal`, `createStreamTerminalTracker`
//! and the incomplete stream failure). The legacy Web Streams cleanup and the
//! trailing usage deadline have no counterpart here: the Rust proxy ends a
//! stream through tokio, not through a transformer.

use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// What a client sees when the upstream stream ends with no terminal event.
pub struct StreamFailure {
    pub status: u16,
    pub message: &'static str,
    pub error_type: &'static str,
    pub code: &'static str,
}

pub const INCOMPLETE_STREAM_FAILURE: StreamFailure = StreamFailure {
    status: 502,
    message: "Upstream stream ended before a terminal event",
    error_type: "server_error",
    code: "upstream_protocol_error",
};

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// The record a Gemini or Antigravity payload carries its candidates in:
/// the payload itself, else its `response`.
fn candidates_root(root: &Map<String, Value>) -> Option<&Map<String, Value>> {
    if truthy(root.get("candidates")) {
        Some(root)
    } else {
        root.get("response").and_then(Value::as_object)
    }
}

fn non_empty_string(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty())
}

/// Explicit protocol completion, independent of whether any text or usage was
/// produced.
pub fn is_stream_terminal(payload: &Value, format: &str) -> bool {
    let empty = Map::new();
    let root = payload.as_object().unwrap_or(&empty);
    match format {
        "openai" => {
            // An explicit `[DONE]` still counts.
            root.get("done") == Some(&Value::Bool(true))
                || root
                    .get("choices")
                    .and_then(Value::as_array)
                    .is_some_and(|choices| {
                        choices
                            .iter()
                            .any(|choice| non_empty_string(choice.get("finish_reason")))
                    })
        }
        "claude" => {
            root.get("type").and_then(Value::as_str) == Some("message_stop")
                || root
                    .get("delta")
                    .and_then(|delta| delta.get("stop_reason"))
                    .is_some_and(Value::is_string)
        }
        "openai-responses" | "codex" => matches!(
            root.get("type").and_then(Value::as_str),
            Some(
                "response.completed"
                    | "response.incomplete"
                    | "response.failed"
                    | "response.cancelled"
                    | "response.canceled"
            )
        ),
        "gemini" | "antigravity" => candidates_root(root)
            .and_then(|response| response.get("candidates"))
            .and_then(Value::as_array)
            .is_some_and(|candidates| {
                candidates
                    .iter()
                    .any(|candidate| candidate.get("finishReason").is_some_and(Value::is_string))
            }),
        "ollama" => root.get("done") == Some(&Value::Bool(true)),
        _ => false,
    }
}

/// Formats whose upstream must end with a terminal event.
pub fn requires_stream_terminal(format: &str) -> bool {
    matches!(
        format,
        "openai" | "claude" | "openai-responses" | "codex" | "gemini" | "antigravity" | "ollama"
    )
}

/// Legacy `createStreamTerminalTracker`: a finish for one choice must not stop
/// the other choices still generating, so every choice seen must have
/// finished, and at least `expected` of them.
pub struct StreamTerminalTracker {
    format: String,
    expected: usize,
    seen: BTreeSet<u64>,
    finished: BTreeSet<u64>,
}

impl StreamTerminalTracker {
    /// `expected_choices` below 1 counts as 1, as in the legacy tracker.
    pub fn new(format: &str, expected_choices: i64) -> Self {
        Self {
            format: format.to_owned(),
            expected: usize::try_from(expected_choices)
                .ok()
                .filter(|count| *count > 0)
                .unwrap_or(1),
            seen: BTreeSet::new(),
            finished: BTreeSet::new(),
        }
    }

    /// Feed one stream payload; true once the stream is terminal.
    pub fn observe(&mut self, payload: &Value) -> bool {
        let empty = Map::new();
        let root = payload.as_object().unwrap_or(&empty);
        let openai = self.format == "openai";
        if root.get("done") == Some(&Value::Bool(true)) && openai {
            return true;
        }
        let choices = if openai {
            root.get("choices")
        } else {
            candidates_root(root).and_then(|response| response.get("candidates"))
        };
        if matches!(self.format.as_str(), "openai" | "gemini" | "antigravity") {
            if let Some(Value::Array(choices)) = choices {
                for (position, value) in choices.iter().enumerate() {
                    let index = value
                        .get("index")
                        .and_then(Value::as_f64)
                        .unwrap_or(position as f64);
                    // `-0` and `0` are one JavaScript number.
                    let key = if index == 0.0 {
                        0.0_f64.to_bits()
                    } else {
                        index.to_bits()
                    };
                    self.seen.insert(key);
                    let reason = value.get(if openai {
                        "finish_reason"
                    } else {
                        "finishReason"
                    });
                    if non_empty_string(reason) {
                        self.finished.insert(key);
                    }
                }
                return self.finished.len() >= self.expected
                    && self.seen.iter().all(|key| self.finished.contains(key));
            }
        }
        is_stream_terminal(payload, &self.format)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Outputs the legacy functions produced for the same inputs
    /// (`stream_terminal_oracle.json`, generated with Node).
    #[test]
    fn terminal_detection_matches_the_legacy_implementation() {
        let oracle: Value =
            serde_json::from_str(include_str!("stream_terminal_oracle.json")).unwrap();
        for case in oracle["terminal"].as_array().unwrap() {
            assert_eq!(
                is_stream_terminal(&case[0], case[1].as_str().unwrap()),
                case[2].as_bool().unwrap(),
                "{case}"
            );
        }
        for case in oracle["requires"].as_array().unwrap() {
            assert_eq!(
                requires_stream_terminal(case[0].as_str().unwrap()),
                case[1].as_bool().unwrap(),
                "{case}"
            );
        }
        for run in oracle["tracker"].as_array().unwrap() {
            let mut tracker = StreamTerminalTracker::new(
                run["format"].as_str().unwrap(),
                run["expected"].as_i64().unwrap(),
            );
            for (payload, expected) in run["steps"]
                .as_array()
                .unwrap()
                .iter()
                .map(|step| (&step[0], step[1].as_bool().unwrap()))
            {
                assert_eq!(tracker.observe(payload), expected, "{run} at {payload}");
            }
        }
        assert_eq!(INCOMPLETE_STREAM_FAILURE.status, 502);
    }
}
