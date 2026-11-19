//! Tool schema sanitizers from the legacy
//! `open-sse/translator/helpers/schemaCoercion.ts`: `coerceSchemaNumericFields`,
//! `coerceToolSchemas` and `sanitizeToolDescriptions`.
//!
//! IDE and SDK harnesses send JSON Schema numeric constraints as strings,
//! `default` values models eagerly fill in, regex lookaround OpenAI rejects,
//! and non-string descriptions. The legacy `translateRequest` cleans every
//! tool list before it reaches the upstream.

use serde_json::{Map, Value};

const NUMERIC_SCHEMA_FIELDS: [&str; 11] = [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
    "multipleOf",
];

const SCHEMA_MAP_FIELDS: [&str; 5] = [
    "properties",
    "patternProperties",
    "definitions",
    "$defs",
    "dependentSchemas",
];

const SCHEMA_LIST_FIELDS: [&str; 4] = ["prefixItems", "anyOf", "oneOf", "allOf"];

const SCHEMA_OBJECT_FIELDS: [&str; 4] = ["not", "if", "then", "else"];

/// `(?=`, `(?!`, `(?<=` or `(?<!` in a `pattern` string.
fn has_regex_lookaround(pattern: Option<&Value>) -> bool {
    let Some(Value::String(pattern)) = pattern else {
        return false;
    };
    let bytes = pattern.as_bytes();
    (0..bytes.len()).any(|index| {
        let rest = &bytes[index..];
        rest.starts_with(b"(?=")
            || rest.starts_with(b"(?!")
            || rest.starts_with(b"(?<=")
            || rest.starts_with(b"(?<!")
    })
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// JavaScript `Number(text)` for a trimmed, non-empty string.
fn js_number(text: &str) -> Option<f64> {
    let radix = |prefix: [&str; 2], radix: u32| {
        prefix
            .iter()
            .find_map(|prefix| text.strip_prefix(prefix))
            .map(|digits| {
                if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                    None
                } else {
                    u128::from_str_radix(digits, radix).ok().map(|n| n as f64)
                }
            })
    };
    if let Some(parsed) = radix(["0x", "0X"], 16)
        .or_else(|| radix(["0o", "0O"], 8))
        .or_else(|| radix(["0b", "0B"], 2))
    {
        return parsed;
    }
    // Rust accepts spellings JavaScript does not (`inf`, `nan`); both are
    // non-finite and left alone by the caller either way.
    if !text
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | 'e' | 'E'))
    {
        return None;
    }
    text.parse::<f64>().ok()
}

fn number_value(number: f64) -> Option<Value> {
    if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 {
        return Some(Value::from(number as i64));
    }
    serde_json::Number::from_f64(number).map(Value::Number)
}

fn coerce_numeric_string(value: &mut Value) {
    let Value::String(text) = value else {
        return;
    };
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return;
    }
    if let Some(number) = js_number(trimmed)
        .filter(|number| number.is_finite())
        .and_then(number_value)
    {
        *value = number;
    }
}

fn coerce_in_place(value: &mut Value) {
    *value = coerce_schema_numeric_fields(std::mem::take(value));
}

/// An object schema without declared properties stays open, as the legacy
/// `keepOpaqueObjectSchemasOpen` does for strict upstream validators.
fn keep_opaque_object_schemas_open(schema: &mut Map<String, Value>) {
    if schema.contains_key("additionalProperties") {
        return;
    }
    let properties = schema.get("properties");
    let is_object = schema.get("type").and_then(Value::as_str) == Some("object")
        || matches!(properties, Some(Value::Object(_)));
    if !is_object {
        return;
    }
    match properties {
        None => {
            schema.insert("properties".to_owned(), Value::Object(Map::new()));
            schema.insert("additionalProperties".to_owned(), Value::Bool(true));
        }
        Some(Value::Object(properties)) if properties.is_empty() => {
            schema.insert("additionalProperties".to_owned(), Value::Bool(true));
        }
        _ => {}
    }
}

/// Legacy `coerceSchemaNumericFields`.
pub(crate) fn coerce_schema_numeric_fields(schema: Value) -> Value {
    let mut schema = match schema {
        Value::Array(entries) => {
            return Value::Array(
                entries
                    .into_iter()
                    .map(coerce_schema_numeric_fields)
                    .collect(),
            )
        }
        Value::Object(schema) => schema,
        other => return other,
    };
    // Models eagerly inject optional fields that carry a `default` (#1782).
    schema.remove("default");
    if has_regex_lookaround(schema.get("pattern")) {
        schema.remove("pattern");
    }
    for field in NUMERIC_SCHEMA_FIELDS {
        if let Some(value) = schema.get_mut(field) {
            coerce_numeric_string(value);
        }
    }
    for field in SCHEMA_MAP_FIELDS {
        if let Some(Value::Object(entries)) = schema.get_mut(field) {
            entries.values_mut().for_each(coerce_in_place);
        }
    }
    if let Some(items) = schema.get_mut("items") {
        coerce_in_place(items);
    }
    for field in ["additionalProperties", "unevaluatedProperties"] {
        // JavaScript `value && typeof value === "object"`: objects and arrays.
        if let Some(value @ (Value::Object(_) | Value::Array(_))) = schema.get_mut(field) {
            coerce_in_place(value);
        }
    }
    for field in SCHEMA_LIST_FIELDS {
        if let Some(Value::Array(entries)) = schema.get_mut(field) {
            entries.iter_mut().for_each(coerce_in_place);
        }
    }
    for field in SCHEMA_OBJECT_FIELDS {
        if let Some(value @ Value::Object(_)) = schema.get_mut(field) {
            coerce_in_place(value);
        }
    }
    keep_opaque_object_schemas_open(&mut schema);
    Value::Object(schema)
}

/// Legacy `coerceToolSchemas` over one tool.
fn coerce_tool_schema(tool: &mut Value) {
    let Some(tool) = tool.as_object_mut() else {
        return;
    };
    let function_object = matches!(tool.get("function"), Some(Value::Object(_)));
    if let Some(parameters) = tool
        .get_mut("function")
        .and_then(Value::as_object_mut)
        .and_then(|function| function.get_mut("parameters"))
    {
        coerce_in_place(parameters);
    }
    if let Some(schema) = tool.get_mut("input_schema") {
        coerce_in_place(schema);
    }
    if !function_object {
        if let Some(parameters) = tool.get_mut("parameters") {
            coerce_in_place(parameters);
        }
    }
    if let Some(Value::Array(declarations)) = tool.get_mut("functionDeclarations") {
        for declaration in declarations.iter_mut().filter_map(Value::as_object_mut) {
            if let Some(parameters) = declaration.get_mut("parameters") {
                coerce_in_place(parameters);
            }
        }
    }
}

/// Legacy `sanitizeDescriptionValue`: `null` becomes empty and any other
/// non-string takes its JavaScript string form.
fn sanitize_description(description: &mut Value) {
    let text = match &*description {
        Value::String(_) => return,
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => match number.as_f64() {
            Some(float) if float.fract() == 0.0 && float.abs() < 1e21 => format!("{float:.0}"),
            _ => number.to_string(),
        },
        composite @ (Value::Array(_) | Value::Object(_)) => js_array_or_object_string(composite),
    };
    *description = Value::String(text);
}

fn js_array_or_object_string(value: &Value) -> String {
    match value {
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                Value::String(text) => text.clone(),
                Value::Array(_) | Value::Object(_) => js_array_or_object_string(item),
                other => {
                    let mut other = other.clone();
                    sanitize_description(&mut other);
                    other.as_str().unwrap_or_default().to_owned()
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => "[object Object]".to_owned(),
    }
}

/// Legacy `sanitizeToolDescription`.
fn sanitize_tool_description(tool: &mut Value) {
    let Some(tool) = tool.as_object_mut() else {
        return;
    };
    match tool.get_mut("function") {
        Some(Value::Object(function)) => {
            if let Some(description) = function.get_mut("description") {
                sanitize_description(description);
            }
        }
        _ => {
            if let Some(description) = tool.get_mut("description") {
                sanitize_description(description);
            }
        }
    }
    if let Some(Value::Array(declarations)) = tool.get_mut("functionDeclarations") {
        for declaration in declarations.iter_mut().filter_map(Value::as_object_mut) {
            if let Some(description) = declaration.get_mut("description") {
                sanitize_description(description);
            }
        }
    }
}

/// Legacy `coerceToolSchemas` then `sanitizeToolDescriptions` on a body's
/// `tools` array.
pub(crate) fn sanitize_tools(body: &mut Value) {
    let Some(Value::Array(tools)) = body.get_mut("tools") else {
        return;
    };
    for tool in tools.iter_mut() {
        coerce_tool_schema(tool);
        sanitize_tool_description(tool);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numeric_strings_defaults_and_lookaround_are_cleaned_recursively() {
        let schema = coerce_schema_numeric_fields(json!({
            "type":"object",
            "properties":{
                "email":{"type":"string","pattern":"^(?=.*@).+$","minLength":" 3 ","default":"a@b"},
                "plain":{"type":"string","pattern":"^[a-z]+$","maxLength":"0x10"},
                "ratio":{"type":"number","minimum":"1.5","maximum":"abc","multipleOf":""},
                "list":{"type":"array","items":{"type":"integer","maximum":"1e2"},"minItems":"Infinity"},
                "default":{"type":"string"}
            },
            "anyOf":[{"type":"object"}],
            "$defs":{"node":{"type":"object","properties":{"id":{"type":"string"}}}},
            "not":{"default":1}
        }));
        assert_eq!(
            schema["properties"]["email"],
            json!({"type":"string","minLength":3})
        );
        assert_eq!(
            schema["properties"]["plain"],
            json!({"type":"string","pattern":"^[a-z]+$","maxLength":16})
        );
        assert_eq!(
            schema["properties"]["ratio"],
            json!({"type":"number","minimum":1.5,"maximum":"abc","multipleOf":""})
        );
        assert_eq!(schema["properties"]["list"]["items"]["maximum"], 100);
        assert_eq!(schema["properties"]["list"]["minItems"], "Infinity");
        assert_eq!(schema["properties"]["default"], json!({"type":"string"}));
        // Object schemas without properties stay open; declared ones do not.
        assert_eq!(
            schema["anyOf"][0],
            json!({"type":"object","properties":{},"additionalProperties":true})
        );
        assert!(schema["$defs"]["node"]
            .get("additionalProperties")
            .is_none());
        assert!(schema.get("additionalProperties").is_none());
        assert_eq!(schema["not"], json!({}));
    }

    #[test]
    fn tools_of_every_shape_are_coerced_and_described() {
        let mut body = json!({"tools":[
            {"type":"function","function":{"name":"a","description":null,"parameters":{"type":"object","properties":{"n":{"type":"integer","minimum":"2"}}}}},
            {"name":"b","description":5,"input_schema":{"type":"object"}},
            {"functionDeclarations":[{"name":"c","description":[1,"x"],"parameters":{"type":"object","properties":{}}}, "raw"]},
            "opaque"
        ]});
        sanitize_tools(&mut body);
        assert_eq!(
            body["tools"][0]["function"],
            json!({"name":"a","description":"","parameters":{"type":"object","properties":{"n":{"type":"integer","minimum":2}}}})
        );
        assert_eq!(body["tools"][1]["description"], "5");
        assert_eq!(
            body["tools"][1]["input_schema"],
            json!({"type":"object","properties":{},"additionalProperties":true})
        );
        assert_eq!(
            body["tools"][2]["functionDeclarations"][0],
            json!({"name":"c","description":"1,x","parameters":{"type":"object","properties":{},"additionalProperties":true}})
        );
        assert_eq!(body["tools"][2]["functionDeclarations"][1], "raw");
        assert_eq!(body["tools"][3], "opaque");
    }
}
