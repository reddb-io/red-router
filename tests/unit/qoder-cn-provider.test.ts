import assert from "node:assert/strict";
import test from "node:test";

import { REGISTRY } from "../../open-sse/config/providers/index.ts";
import { getExecutor } from "../../open-sse/executors/index.ts";
import { getProvider } from "../../src/lib/oauth/providers.ts";
import { OAUTH_TEST_CONFIG } from "../../src/app/api/providers/[id]/test/oauthTestConfig.ts";
import { OAUTH_PROVIDERS, resolveProviderId } from "../../src/shared/constants/providers.ts";

test("Qoder CN is a separate China provider, not an alias for global Qoder", async () => {
  assert.equal(REGISTRY["qoder-cn"].alias, "qdcn");
  assert.equal(REGISTRY["qoder-cn"].executor, "qoder-cn");
  assert.equal(new URL(REGISTRY["qoder-cn"].baseUrl || "").host, "gateway.qoder.com.cn");
  assert.notEqual(REGISTRY["qoder-cn"].baseUrl, REGISTRY.qoder.baseUrl);
  assert.equal(resolveProviderId("qdcn"), "qoder-cn");
  assert.equal(OAUTH_PROVIDERS["qoder-cn"].alias, "qdcn");
  assert.equal(getProvider("qoder-cn").flowType, "device_code");
  assert.equal(OAUTH_TEST_CONFIG["qoder-cn"].refreshable, false);
  assert.notEqual(OAUTH_TEST_CONFIG["qoder-cn"].checkExpiry, true);
  assert.equal((await getExecutor("qdcn")).getProvider(), "qoder-cn");
  assert.equal((await getExecutor("qoder-cn")).getProvider(), "qoder-cn");
});
