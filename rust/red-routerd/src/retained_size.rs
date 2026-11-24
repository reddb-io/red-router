//! Retained payload size admission, ported from the legacy
//! `src/lib/retainedSize.ts`.
//!
//! A conservative estimate of what retaining a JSON payload costs, charged
//! as the legacy router charges its JavaScript values (UTF-16 strings and
//! container overhead), so many tiny deltas also exhaust a budget. The walk
//! stops at the budget instead of serializing the whole body.

use serde_json::Value;

const MAX_DEPTH: usize = 64;

/// Legacy `estimateRetainedBytes`: the estimate, or none when the value is
/// nested more than 64 levels deep or the budget is exceeded.
pub fn estimate_retained_bytes(value: &Value, max_bytes: u64) -> Option<u64> {
    let mut bytes = 0_u64;
    visit(value, 0, max_bytes, &mut bytes).then_some(bytes)
}

fn visit(item: &Value, depth: usize, max_bytes: u64, bytes: &mut u64) -> bool {
    let mut charge = |amount: u64| {
        *bytes = bytes.saturating_add(amount);
        *bytes <= max_bytes
    };
    match item {
        // JavaScript string length counts UTF-16 code units.
        Value::String(text) => charge(24 + text.encode_utf16().count() as u64 * 2),
        Value::Null | Value::Bool(_) | Value::Number(_) => charge(8),
        _ if depth > MAX_DEPTH => false,
        Value::Array(items) => {
            if !charge(64) {
                return false;
            }
            items.iter().all(|entry| {
                *bytes = bytes.saturating_add(8);
                *bytes <= max_bytes && visit(entry, depth + 1, max_bytes, bytes)
            })
        }
        Value::Object(record) => {
            if !charge(64) {
                return false;
            }
            record.iter().all(|(key, entry)| {
                *bytes = bytes.saturating_add(32 + key.encode_utf16().count() as u64 * 2);
                *bytes <= max_bytes && visit(entry, depth + 1, max_bytes, bytes)
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Ported from tests/redrouter/native/retained-size.test.ts. JSON values
    // have no getters, cycles, buffers or exotic types, so those cases reduce
    // to the budget and depth rules.
    #[test]
    fn admission_stops_at_the_budget_and_fails_closed_when_too_deep() {
        assert_eq!(
            estimate_retained_bytes(&json!({"body": "x".repeat(4096)}), 1024),
            None
        );
        let empties = Value::Array((0..100).map(|_| json!({})).collect());
        assert!(estimate_retained_bytes(&empties, 1_000_000).unwrap() > 6000);
        assert!(estimate_retained_bytes(&json!({"value": "small"}), 1024).is_some());
        let mut deep = json!("leaf");
        for _ in 0..100 {
            deep = json!({"child": deep});
        }
        assert_eq!(estimate_retained_bytes(&deep, 1_000_000), None);
        assert_eq!(estimate_retained_bytes(&json!("small"), 0), None);
        // A string costs 24 bytes plus two per UTF-16 unit.
        assert_eq!(estimate_retained_bytes(&json!("ab"), 1024), Some(28));
        assert_eq!(estimate_retained_bytes(&json!("😀"), 1024), Some(28));
        assert_eq!(estimate_retained_bytes(&json!([1]), 1024), Some(64 + 8 + 8));
        assert_eq!(
            estimate_retained_bytes(&json!({"k": null}), 1024),
            Some(64 + 34 + 8)
        );
    }
}
