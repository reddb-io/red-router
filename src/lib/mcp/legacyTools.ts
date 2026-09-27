import { createLegacyCatalogTools } from "./legacyCatalogTools";
import { loadLegacyKeyCatalog } from "./legacyCatalogLoader";
import { loadLegacyCatalogHealth } from "./legacyCatalogHealthLoader";
import { createLegacyProviderTool } from "./legacyProviderTool";
import { legacyProviderStore } from "./legacyProviderStore";
import { createLegacyQuotaTool } from "./legacyQuotaTool";
import { createLegacyUsageTool } from "./legacyUsageTool";
import { createLegacyKeyTools } from "./legacyKeyTools";

/** Scoped legacy MCP contract; the HTTP route must authenticate before calling it. */
export function createLegacyReadTools() {
  return [
    ...createLegacyCatalogTools(loadLegacyKeyCatalog, loadLegacyCatalogHealth),
    createLegacyProviderTool(legacyProviderStore),
    createLegacyQuotaTool(),
    createLegacyUsageTool(),
    ...createLegacyKeyTools(),
  ];
}
