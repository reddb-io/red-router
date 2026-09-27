import { createLegacyCatalogTools } from "./legacyCatalogTools";
import { loadLegacyKeyCatalog } from "./legacyCatalogLoader";
import { loadLegacyCatalogHealth } from "./legacyCatalogHealthLoader";
import { createLegacyProviderTool } from "./legacyProviderTool";
import { legacyProviderStore } from "./legacyProviderStore";
import { createLegacyQuotaTool, legacyQuotaStore } from "./legacyQuotaTool";
import { refreshLegacyQuotaConnection } from "./legacyQuotaRefresh";
import { createLegacyUsageTool } from "./legacyUsageTool";
import { createLegacyKeyTools } from "./legacyKeyTools";
import { createLegacyCreateKeyTool } from "./legacyCreateKeyTool";

/** Scoped legacy MCP contract; the HTTP route must authenticate before calling it. */
export function createLegacyTools() {
  return [
    ...createLegacyCatalogTools(loadLegacyKeyCatalog, loadLegacyCatalogHealth),
    createLegacyProviderTool(legacyProviderStore),
    createLegacyQuotaTool({ ...legacyQuotaStore, refresh: refreshLegacyQuotaConnection }),
    createLegacyUsageTool(),
    ...createLegacyKeyTools(),
    createLegacyCreateKeyTool(),
  ];
}
