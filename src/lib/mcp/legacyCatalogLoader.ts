import { getUnifiedModelsResponse } from "@/app/api/v1/models/catalog";
import { LegacyMcpToolError } from "./legacyProtocol";
import { parseLegacyKeyCatalog, type LegacyCatalogLoader } from "./legacyCatalogTools";

/** Reuse the key-filtered public model catalog rather than rebuilding its policy. */
export const loadLegacyKeyCatalog: LegacyCatalogLoader = async (context) => {
  if (!context.apiKeyToken) throw new LegacyMcpToolError("forbidden", "API key required");
  const request = new Request("http://localhost/v1/models", {
    headers: { Authorization: `Bearer ${context.apiKeyToken}` },
  });
  const response = await getUnifiedModelsResponse(request);
  if (!response.ok)
    throw new LegacyMcpToolError("catalog_unavailable", "Model catalog unavailable");
  return parseLegacyKeyCatalog(await response.json());
};
