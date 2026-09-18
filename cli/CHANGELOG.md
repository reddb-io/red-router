# @reddb-io/red-router

## 0.2.0

### Minor Changes

- 61edd85: Expose `thinking_levels` per model and LLM combo in `/v1/models` and `/v1/models/info` (intersection across members for combos), and accept thinking-suffix overrides on combo names: `my-combo(high)` applies the level to every routed member, clamped to each member's supported levels.
