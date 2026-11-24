// Logging and feature-flag modules that error.ts imports but the error body
// and message sanitizing do not use.
export const normalizePayloadForLog = (value) => value;
export const isFeatureFlagEnabled = () => false;
export const setConnectionRateLimitUntil = async () => {};
