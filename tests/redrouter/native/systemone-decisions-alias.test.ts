import assert from "node:assert/strict";
import test from "node:test";

import * as decisionsRoute from "../../../src/app/api/v1/decisions/route.ts";
import * as systemOneRoute from "../../../src/app/api/v1/systemone/route.ts";
import { resolveEndpointCategory } from "../../../src/shared/constants/endpointCategories.ts";

test("/v1/decisions delegates to the exact System One protocol handlers", () => {
  assert.equal(decisionsRoute.POST, systemOneRoute.POST);
  assert.equal(decisionsRoute.OPTIONS, systemOneRoute.OPTIONS);
  assert.equal(decisionsRoute.dynamic, "force-dynamic");
});

test("System One and Decisions share API-key endpoint policy", () => {
  assert.equal(resolveEndpointCategory("/v1/systemone"), "decisions");
  assert.equal(resolveEndpointCategory("/v1/decisions"), "decisions");
});
