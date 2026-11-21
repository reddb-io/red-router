// Same body as the legacy isOpenAIResponsesStoreEnabled (requestDefaults.ts),
// without the database-bound imports that module drags in.
export function isOpenAIResponsesStoreEnabled(providerSpecificData) {
  const record = providerSpecificData && typeof providerSpecificData === "object" && !Array.isArray(providerSpecificData) ? providerSpecificData : {};
  return record.openaiStoreEnabled === true;
}
