//! Strict usage normalization and pricing primitives for future quota accounting.
//! These functions do not record usage or authorize requests.
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatUsage {
    pub input: u64,
    pub output: u64,
    pub reasoning: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}

impl ChatUsage {
    /// Parse a completed OpenAI-compatible response. Missing or inconsistent
    /// accounting must not be interpreted as free usage.
    pub fn from_response(response: &Value) -> Result<Self, &'static str> {
        let usage = response
            .get("usage")
            .and_then(Value::as_object)
            .ok_or("usage is missing")?;
        let required = |field: &str| {
            usage
                .get(field)
                .and_then(Value::as_u64)
                .ok_or("invalid token usage")
        };
        let input = required("prompt_tokens")?;
        let output = required("completion_tokens")?;
        let prompt_details = usage.get("prompt_tokens_details").filter(|v| !v.is_null());
        let output_details = usage
            .get("completion_tokens_details")
            .filter(|v| !v.is_null());
        if prompt_details.is_some_and(|v| !v.is_object())
            || output_details.is_some_and(|v| !v.is_object())
        {
            return Err("invalid token details");
        }
        let optional = |value: Option<&Value>| match value {
            None | Some(Value::Null) => Ok(0),
            Some(value) => value.as_u64().ok_or("invalid token details"),
        };
        let cache_read = optional(prompt_details.and_then(|v| v.get("cached_tokens")))?;
        let cache_creation = optional(prompt_details.and_then(|v| {
            v.get("cache_creation_tokens")
                .or_else(|| v.get("cache_write_tokens"))
        }))?;
        let reasoning = optional(output_details.and_then(|v| v.get("reasoning_tokens")))?;
        if cache_read
            .checked_add(cache_creation)
            .is_none_or(|n| n > input)
            || reasoning > output
        {
            return Err("inconsistent token details");
        }
        let result = Self {
            input,
            output,
            reasoning,
            cache_read,
            cache_creation,
        };
        result.billable_tokens()?;
        Ok(result)
    }

    /// Matches the product's quota counter (input + output + reasoning).
    pub fn billable_tokens(&self) -> Result<u64, &'static str> {
        self.input
            .checked_add(self.output)
            .and_then(|n| n.checked_add(self.reasoning))
            .filter(|n| *n <= i64::MAX as u64)
            .ok_or("token usage overflow")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TokenPrices {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_creation: f64,
    pub reasoning: f64,
}

impl TokenPrices {
    /// Read explicit per-million-token prices; absent input/output prices are
    /// unknown, not zero. Optional prices follow the current product defaults.
    pub fn from_record(record: &Value) -> Result<Self, &'static str> {
        let object = record.as_object().ok_or("pricing is missing")?;
        let read = |name: &str| -> Result<Option<f64>, &'static str> {
            match object.get(name) {
                None | Some(Value::Null) => Ok(None),
                Some(value) => value
                    .as_f64()
                    .filter(|v| v.is_finite() && *v >= 0.0)
                    .map(Some)
                    .ok_or("invalid token price"),
            }
        };
        let input = read("input")?.ok_or("input price is missing")?;
        let output = read("output")?.ok_or("output price is missing")?;
        Ok(Self {
            input,
            output,
            cache_read: read("cached")?.unwrap_or(input),
            cache_creation: read("cache_creation")?.unwrap_or(input),
            reasoning: read("reasoning")?.unwrap_or(output),
        })
    }

    /// Match the product's pricing for ordinary OpenAI-compatible token usage.
    pub fn cost_usd(&self, usage: &ChatUsage) -> Result<f64, &'static str> {
        if [
            self.input,
            self.output,
            self.cache_read,
            self.cache_creation,
            self.reasoning,
        ]
        .into_iter()
        .any(|price| !price.is_finite() || price < 0.0)
        {
            return Err("invalid token price");
        }
        let cached = usage
            .cache_read
            .checked_add(usage.cache_creation)
            .ok_or("invalid token usage")?;
        if cached > usage.input || usage.reasoning > usage.output {
            return Err("invalid token usage");
        }
        let cost = ((usage.input - cached) as f64 * self.input
            + usage.cache_read as f64 * self.cache_read
            + usage.cache_creation as f64 * self.cache_creation
            + (usage.output - usage.reasoning) as f64 * self.output
            + usage.reasoning as f64 * self.reasoning)
            / 1_000_000.0;
        if !cost.is_finite() || cost < 0.0 {
            return Err("invalid calculated cost");
        }
        Ok(cost)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_breakdowns_and_matches_product_cost_math() {
        let usage = ChatUsage::from_response(&json!({"usage":{
            "prompt_tokens":100,"completion_tokens":50,
            "prompt_tokens_details":{"cached_tokens":20,"cache_creation_tokens":10},
            "completion_tokens_details":{"reasoning_tokens":10}
        }}))
        .unwrap();
        assert_eq!(usage.billable_tokens().unwrap(), 160);
        let prices = TokenPrices::from_record(
            &json!({"input":2,"output":4,"cached":0.5,"cache_creation":3,"reasoning":6}),
        )
        .unwrap();
        assert!((prices.cost_usd(&usage).unwrap() - 0.0004).abs() < 1e-12);
    }

    #[test]
    fn missing_or_inconsistent_usage_and_unknown_prices_fail_closed() {
        for response in [
            json!({}),
            json!({"usage":{"prompt_tokens":0}}),
            json!({"usage":{"prompt_tokens":-1,"completion_tokens":0}}),
            json!({"usage":{"prompt_tokens":1,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":2}}}),
            json!({"usage":{"prompt_tokens":1,"completion_tokens":1,"completion_tokens_details":{"reasoning_tokens":2}}}),
            json!({"usage":{"prompt_tokens":u64::MAX,"completion_tokens":1}}),
        ] {
            assert!(ChatUsage::from_response(&response).is_err());
        }
        assert!(TokenPrices::from_record(&json!({"input":1})).is_err());
        assert!(TokenPrices::from_record(&json!({"input":-1,"output":1})).is_err());
        assert_eq!(
            TokenPrices::from_record(&json!({"input":0,"output":0}))
                .unwrap()
                .input,
            0.0
        );
    }
}
