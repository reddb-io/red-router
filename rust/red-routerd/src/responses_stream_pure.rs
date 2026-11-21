//! Pure helpers of the Responses to Chat response translation, ported from the
//! legacy `translator/response/openai-responses/pureHelpers.ts`.

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Number, Value};
use std::fmt;

/// A JSON value that keeps its object keys in source order, as `JSON.parse`
/// and `JSON.stringify` do. `serde_json::Value` sorts keys, which would
/// reorder the tool arguments a client sees.
#[derive(Debug, Clone, PartialEq)]
pub enum Ordered {
    Object(Vec<(String, Ordered)>),
    Array(Vec<Ordered>),
    Scalar(Value),
}

impl Ordered {
    pub fn to_value(&self) -> Value {
        match self {
            Self::Object(entries) => Value::Object(
                entries
                    .iter()
                    .map(|(key, value)| (key.clone(), value.to_value()))
                    .collect(),
            ),
            Self::Array(items) => Value::Array(items.iter().map(Self::to_value).collect()),
            Self::Scalar(value) => value.clone(),
        }
    }

    pub fn from_value(value: &Value) -> Self {
        match value {
            Value::Object(map) => Self::Object(
                map.iter()
                    .map(|(key, value)| (key.clone(), Self::from_value(value)))
                    .collect(),
            ),
            Value::Array(items) => Self::Array(items.iter().map(Self::from_value).collect()),
            other => Self::Scalar(other.clone()),
        }
    }
}

impl Serialize for Ordered {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Object(entries) => {
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (key, value) in entries {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
            Self::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Self::Scalar(value) => value.serialize(serializer),
        }
    }
}

struct OrderedVisitor;

impl<'de> Visitor<'de> for OrderedVisitor {
    type Value = Ordered;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Ordered, E> {
        Ok(Ordered::Scalar(Value::Bool(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Ordered, E> {
        Ok(Ordered::Scalar(Value::Number(value.into())))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Ordered, E> {
        Ok(Ordered::Scalar(Value::Number(value.into())))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Ordered, E> {
        // JavaScript has one number type: `3.0` prints as `3`.
        if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
            return Ok(Ordered::Scalar(Value::Number((value as i64).into())));
        }
        Number::from_f64(value)
            .map(|number| Ordered::Scalar(Value::Number(number)))
            .ok_or_else(|| E::custom("non-finite number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Ordered, E> {
        Ok(Ordered::Scalar(Value::String(value.to_owned())))
    }

    fn visit_string<E>(self, value: String) -> Result<Ordered, E> {
        Ok(Ordered::Scalar(Value::String(value)))
    }

    fn visit_unit<E>(self) -> Result<Ordered, E> {
        Ok(Ordered::Scalar(Value::Null))
    }

    fn visit_none<E>(self) -> Result<Ordered, E> {
        Ok(Ordered::Scalar(Value::Null))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Ordered, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(Ordered::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Ordered, A::Error> {
        let mut entries: Vec<(String, Ordered)> = Vec::new();
        while let Some((key, value)) = map.next_entry::<String, Ordered>()? {
            // `JSON.parse` keeps the last duplicate at the first one's position.
            match entries.iter_mut().find(|(existing, _)| *existing == key) {
                Some(slot) => slot.1 = value,
                None => entries.push((key, value)),
            }
        }
        Ok(Ordered::Object(entries))
    }
}

impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(OrderedVisitor)
    }
}

/// Legacy `normalizeToolName`: a trimmed string, otherwise empty.
pub fn normalize_tool_name(value: &Value) -> String {
    value
        .as_str()
        .map(|text| {
            text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
                .to_owned()
        })
        .unwrap_or_default()
}

/// Tools whose empty-string and empty-array optional arguments are safe to
/// strip (#2937 `Read`, `Subagent` from decolua/9router#2446). An empty value
/// can be a valid payload for any other tool.
const STRIPPABLE_EMPTY_ARG_TOOLS: [&str; 2] = ["Read", "Subagent"];

/// `JSON.stringify` equality of two values (a schema `default` against an
/// emitted argument), with numbers compared by value. The legacy comparison
/// also depends on key order; the schema reaches this module as a
/// `serde_json::Value`, whose keys are already sorted, so objects compare
/// regardless of order here. The only difference: an emitted object equal to
/// its default but with its keys in another order is dropped here and kept by
/// the legacy code, which is harmless since the value is the default.
fn json_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| json_equal(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(key, value)| y.get(key).is_some_and(|other| json_equal(value, other)))
        }
        _ => a == b,
    }
}

fn required_contains(schema: Option<&Value>, key: &str) -> bool {
    schema
        .and_then(|schema| schema.get("required"))
        .and_then(Value::as_array)
        .is_some_and(|required| required.iter().any(|entry| entry.as_str() == Some(key)))
}

fn is_empty_entry(entry: &Ordered) -> bool {
    match entry {
        Ordered::Scalar(Value::String(text)) => text.is_empty(),
        Ordered::Array(items) => items.is_empty(),
        _ => false,
    }
}

/// #7023: the request side widens an optional property to accept `null`,
/// meaning "omitted"; the marker is its description.
fn has_omission_sentinel(property: &Value) -> bool {
    let Some(property) = property.as_object() else {
        return false;
    };
    if !property
        .get("description")
        .and_then(Value::as_str)
        .is_some_and(|text| text.contains("null = omit this parameter"))
    {
        return false;
    }
    let type_includes_null = match property.get("type") {
        Some(Value::String(kind)) => kind == "null",
        Some(Value::Array(kinds)) => kinds.iter().any(Value::is_null),
        _ => false,
    };
    type_includes_null
        || property
            .get("enum")
            .and_then(Value::as_array)
            .is_some_and(|values| values.iter().any(Value::is_null))
}

fn strip_object(entries: &mut Vec<(String, Ordered)>, tool_name: &str, schema: Option<&Value>) {
    let properties = schema
        .and_then(|schema| schema.get("properties"))
        .and_then(Value::as_object);
    let allowlisted = STRIPPABLE_EMPTY_ARG_TOOLS.contains(&tool_name);
    entries.retain(|(key, entry)| {
        let property = properties.and_then(|properties| properties.get(key));
        let declared = property.is_some_and(|property| !property.is_null());
        let required = required_contains(schema, key);
        let matches_default = property
            .and_then(Value::as_object)
            .and_then(|property| property.get("default"))
            .is_some_and(|default| json_equal(&entry.to_value(), default));
        let droppable_empty = is_empty_entry(entry) && (allowlisted || (declared && !required));
        let droppable_null = entry_is_null(entry)
            && (tool_name == "Agent"
                || (declared && (!required || property.is_some_and(has_omission_sentinel))));
        !(matches_default || droppable_empty || droppable_null)
    });
}

fn entry_is_null(entry: &Ordered) -> bool {
    matches!(entry, Ordered::Scalar(Value::Null))
}

fn usable_schema(schema: Option<&Value>) -> Option<&Value> {
    schema.filter(|schema| schema.is_object())
}

/// Legacy `stripEmptyOptionalToolArgs` for a JSON string of arguments (#6951,
/// #9423): drop optional arguments the model filled with an empty value, the
/// schema's own default, or the `null` omission idiom. Without a schema only
/// the allowlisted tools and `Agent` are touched. A string that is not a JSON
/// object, or does not parse, is returned unchanged. Key order is preserved.
pub fn strip_empty_optional_tool_args_str(
    value: &str,
    tool_name: &str,
    schema: Option<&Value>,
) -> String {
    let schema = usable_schema(schema);
    if schema.is_none() && !STRIPPABLE_EMPTY_ARG_TOOLS.contains(&tool_name) && tool_name != "Agent"
    {
        return value.to_owned();
    }
    let Ok(Ordered::Object(mut entries)) = serde_json::from_str::<Ordered>(value) else {
        return value.to_owned();
    };
    strip_object(&mut entries, tool_name, schema);
    serde_json::to_string(&Ordered::Object(entries)).unwrap_or_else(|_| value.to_owned())
}

/// The same normalization for arguments that already arrived as a JSON object.
/// Arrays and scalars pass through.
pub fn strip_empty_optional_tool_args_value(
    value: &Value,
    tool_name: &str,
    schema: Option<&Value>,
) -> Value {
    let Value::Object(_) = value else {
        return value.clone();
    };
    let Ordered::Object(mut entries) = Ordered::from_value(value) else {
        return value.clone();
    };
    strip_object(&mut entries, tool_name, usable_schema(schema));
    Ordered::Object(entries).to_value()
}

/// Legacy `normalizeOutputIndex`: a non-negative integer, otherwise 0. Numbers,
/// numeric strings and booleans follow JavaScript `Number()`; other shapes
/// give 0.
pub fn normalize_output_index(value: &Value) -> u64 {
    let number = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => {
            let trimmed = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
            if trimmed.is_empty() {
                Some(0.0)
            } else {
                trimmed.parse::<f64>().ok()
            }
        }
        Value::Bool(flag) => Some(f64::from(u8::from(*flag))),
        Value::Null => Some(0.0),
        _ => None,
    };
    match number {
        Some(number)
            if number.is_finite()
                && number.fract() == 0.0
                && (0.0..=9_007_199_254_740_991.0).contains(&number) =>
        {
            number as u64
        }
        _ => 0,
    }
}

/// An upstream failure mapped to an HTTP status and error shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamFailure {
    pub status: u16,
    pub error_type: String,
    pub code: String,
    pub message: String,
}

fn objectish(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| value.is_object() || value.is_array())
}

/// Legacy `normalizeUpstreamFailure`: `context_length_exceeded` is 400 (retry
/// smaller), `rate_limit_exceeded` and `rate_limited` are 429 (back off),
/// anything else 502 with the caller's fallback type.
pub fn normalize_upstream_failure(data: &Value, fallback_type: &str) -> UpstreamFailure {
    let empty = Map::new();
    let root = data.as_object().unwrap_or(&empty);
    let response = objectish(root.get("response"));
    let error = objectish(response.and_then(|response| response.get("error")))
        .or_else(|| objectish(root.get("error")));
    let code = error
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let message = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .or_else(|| root.get("message").and_then(Value::as_str))
        .unwrap_or("Upstream failure");
    let rate_limited = matches!(code, "rate_limit_exceeded" | "rate_limited");
    let (status, error_type) = if rate_limited {
        (429, "rate_limit_error")
    } else if code == "context_length_exceeded" {
        (400, "invalid_request_error")
    } else {
        (502, fallback_type)
    };
    let code = if !code.is_empty() {
        code
    } else if rate_limited {
        "rate_limit_exceeded"
    } else {
        "bad_gateway"
    };
    UpstreamFailure {
        status,
        error_type: error_type.to_owned(),
        code: code.to_owned(),
        message: message.to_owned(),
    }
}

/// Legacy `extractResponsesReasoningSummaryText` (#9500): the non-empty
/// summary parts joined by a blank line.
pub fn extract_reasoning_summary_text(item: &Value) -> String {
    let Some(summary) = item.get("summary").and_then(Value::as_array) else {
        return String::new();
    };
    summary
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Outputs the legacy helpers produced for the same inputs
    /// (`responses_stream_pure_oracle.json`, generated with Node).
    #[test]
    fn helpers_match_the_legacy_implementation() {
        let oracle: Value =
            serde_json::from_str(include_str!("responses_stream_pure_oracle.json")).unwrap();
        for case in oracle["strip_string"].as_array().unwrap() {
            let schema = (!case[2].is_null()).then_some(&case[2]);
            assert_eq!(
                strip_empty_optional_tool_args_str(
                    case[0].as_str().unwrap(),
                    case[1].as_str().unwrap(),
                    schema
                ),
                case[3].as_str().unwrap(),
                "{case}"
            );
        }
        for case in oracle["strip_object"].as_array().unwrap() {
            let schema = (!case[2].is_null()).then_some(&case[2]);
            assert_eq!(
                strip_empty_optional_tool_args_value(&case[0], case[1].as_str().unwrap(), schema),
                case[3],
                "{case}"
            );
        }
        for case in oracle["index"].as_array().unwrap() {
            assert_eq!(
                normalize_output_index(&case[0]),
                case[1].as_u64().unwrap(),
                "{case}"
            );
        }
        for case in oracle["failure"].as_array().unwrap() {
            let failure = normalize_upstream_failure(&case[0], case[1].as_str().unwrap());
            let actual = json!({"status": failure.status, "type": failure.error_type, "code": failure.code, "message": failure.message});
            assert_eq!(actual, case[2], "{case}");
        }
        for case in oracle["summary"].as_array().unwrap() {
            assert_eq!(
                extract_reasoning_summary_text(&case[0]),
                case[1].as_str().unwrap(),
                "{case}"
            );
        }
        for case in oracle["name"].as_array().unwrap() {
            assert_eq!(
                normalize_tool_name(&case[0]),
                case[1].as_str().unwrap(),
                "{case}"
            );
        }
    }
}

/// Legacy `extractReplayableResponsesReasoningText` (`reasoningInputPolicy.ts`):
/// the plaintext of a Responses `reasoning` item, its non-blank
/// `reasoning_text` parts joined by a blank line. An item carrying only
/// opaque state yields nothing.
pub fn extract_replayable_reasoning_text(value: &Value) -> String {
    let Some(item) = value.as_object() else {
        return String::new();
    };
    if item.get("type").and_then(Value::as_str) != Some("reasoning") {
        return String::new();
    }
    let Some(parts) = item.get("content").and_then(Value::as_array) else {
        return String::new();
    };
    parts
        .iter()
        .filter_map(|part| {
            let part = part.as_object()?;
            (part.get("type").and_then(Value::as_str) == Some("reasoning_text"))
                .then(|| part.get("text").and_then(Value::as_str))
                .flatten()
        })
        .filter(|text| {
            !text
                .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
                .is_empty()
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod replayable_tests {
    use super::*;

    /// Outputs the legacy function produced for the same inputs
    /// (`reasoning_replayable_oracle.json`, evaluated from the legacy source).
    #[test]
    fn replayable_reasoning_matches_the_legacy_function() {
        let oracle: Vec<(Value, String)> =
            serde_json::from_str(include_str!("reasoning_replayable_oracle.json")).unwrap();
        assert!(oracle.len() >= 15);
        for (input, expected) in &oracle {
            assert_eq!(
                &extract_replayable_reasoning_text(input),
                expected,
                "{input}"
            );
        }
    }
}
