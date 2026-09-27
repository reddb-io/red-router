/** GHSA-9p9m-h9rj-rhhg: hook code must not reach the server realm. */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import {
  clearAllHooks,
  createHookContext,
  getHook,
  registerHook,
  runHooks,
} from "../../src/lib/middleware/registry.ts";
import { HookPriority, type HookConfig } from "../../src/lib/middleware/types.ts";

function hook(name: string, code: string): HookConfig {
  return {
    name,
    code,
    description: "realm isolation",
    priority: HookPriority.NORMAL,
    scope: { type: "global" },
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runCount: 0,
  };
}

function ctx(log?: { info: (tag: string, message: string) => void }) {
  return createHookContext({
    body: { messages: [] },
    headers: { "x-test": "1" },
    model: "gpt-4o",
    log: log ? { info: log.info, warn: () => {}, error: () => {} } : undefined,
  });
}

const PROBES = ["__ghsa9p9mEnv", "__ghsa9p9mProto", "__ghsa9p9mCtor", "__ghsa9p9mArr"];

beforeEach(() => clearAllHooks());
after(() => {
  clearAllHooks();
  for (const key of PROBES) {
    delete (Object.prototype as Record<string, unknown>)[key];
    delete (Array.prototype as unknown as Record<string, unknown>)[key];
  }
  delete (globalThis as Record<string, unknown>).__ghsa9p9mEscaped;
});

test("hook prototype writes do not reach host prototypes", async () => {
  registerHook(
    hook(
      "pollute",
      `Object.prototype.__ghsa9p9mEnv = { NODE_OPTIONS: "--require /tmp/x.js" };
       context.__proto__.__ghsa9p9mProto = 1;
       context.constructor.prototype.__ghsa9p9mCtor = 1;
       context.body.messages.constructor.prototype.__ghsa9p9mArr = 1;`
    )
  );
  await runHooks(ctx());
  for (const key of PROBES) {
    assert.equal(key in {}, false, `host Object.prototype gained ${key}`);
    assert.equal(key in [], false, `host Array.prototype gained ${key}`);
  }
  assert.equal(getHook("pollute")?.lastError, undefined);
});

test("constructor-chain escape cannot compile code in the host", async () => {
  registerHook(
    hook(
      "ctor-escape",
      `const F = this.constructor.constructor;
       return { body: { got: typeof F("return process")() } };`
    )
  );
  const { context } = await runHooks(ctx());
  assert.equal(context.body.got, undefined);
  assert.match(getHook("ctor-escape")?.lastError ?? "", /[Cc]ode generation from strings/);
});

test("replaced realm Promise.then never receives a host function", async () => {
  registerHook(
    hook(
      "then-hijack",
      `Promise.prototype.then = function (resolve) {
         try { resolve.constructor("globalThis.__ghsa9p9mEscaped = true")(); } catch {}
       };
       return { model: "still-here" };`
    )
  );
  await runHooks(ctx());
  assert.equal((globalThis as Record<string, unknown>).__ghsa9p9mEscaped, undefined);
});

test("in-place mutations, returned result and log lines still work", async () => {
  const lines: string[] = [];
  registerHook(
    hook(
      "contract",
      `context.body.injected = "yes";
       context.metadata.seen = true;
       context.log.info("HOOK", "ran for " + context.model);
       return { body: { added: true }, model: "gpt-4o-mini" };`
    )
  );
  const { context } = await runHooks(
    ctx({ info: (tag, message) => lines.push(`${tag}:${message}`) })
  );
  assert.equal(context.body.injected, "yes");
  assert.equal(context.body.added, true);
  assert.equal(context.model, "gpt-4o-mini");
  assert.equal(context.metadata.seen, true);
  assert.deepEqual(lines, ["HOOK:ran for gpt-4o"]);
});

test("unsettled promises fail without holding the request indefinitely", async () => {
  registerHook(hook("never-settles", `await new Promise(() => {}); return { model: "x" };`));
  const { context } = await runHooks(ctx());
  assert.equal(context.model, "gpt-4o");
  assert.match(getHook("never-settles")?.lastError ?? "", /did not finish/);
});
