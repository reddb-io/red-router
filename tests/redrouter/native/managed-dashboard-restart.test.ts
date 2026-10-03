import assert from "node:assert/strict";
import { test } from "node:test";
import { requestServerRestart } from "../../../src/lib/runtime/serverRestart";

const env = { INVOCATION_ID: "owned-invocation", NOTIFY_SOCKET: "/manager/notify" };

test("dashboard restart is admitted to an independent timer, never signalling the child", async () => {
  const calls: Array<[string, string[]]> = [];
  const mode = await requestServerRestart({
    env,
    platform: "linux",
    managedStatus: async () => ({ managed: true }),
    terminate: () => {
      throw new Error("must not kill the HTTP server directly");
    },
    execute: async (command, args) => {
      calls.push([command, args]);
      return { stdout: command === "systemctl" ? env.INVOCATION_ID : "" };
    },
  });
  assert.equal(mode, "service");
  assert.equal(calls[0][0], "systemctl");
  const [command, args] = calls[1];
  assert.equal(command, "systemd-run");
  assert.ok(args.includes("--on-active=1s"));
  assert.ok(args.includes("--collect"));
  assert.deepEqual(args.slice(-4), ["systemctl", "--user", "restart", "red-router.service"]);
});

test("a rejected manager handoff preserves the running server", async () => {
  let terminated = false;
  await assert.rejects(
    requestServerRestart({
      env,
      platform: "linux",
      managedStatus: async () => ({ managed: true }),
      terminate: () => {
        terminated = true;
      },
      execute: async (command) => {
        if (command === "systemd-run") throw new Error("manager rejected job");
        return { stdout: env.INVOCATION_ID };
      },
    }),
    /manager rejected/
  );
  assert.equal(terminated, false);
});

test("a custom service cannot restart a different Router's managed unit", async () => {
  const commands: string[] = [];
  await assert.rejects(
    requestServerRestart({
      env,
      platform: "linux",
      managedStatus: async () => ({ managed: true }),
      execute: async (command) => {
        commands.push(command);
        return { stdout: "another-invocation" };
      },
      terminate: () => {
        throw new Error("must not signal");
      },
    }),
    /does not belong/
  );
  assert.deepEqual(commands, ["systemctl"]);
});

test("standalone restart keeps the existing delayed supervisor signal", async () => {
  let action: (() => void) | undefined;
  let terminated = false;
  assert.equal(
    await requestServerRestart({
      env: {},
      platform: "linux",
      schedule: (fn) => {
        action = fn;
      },
      execute: async () => {
        throw new Error("standalone must not use systemd");
      },
      terminate: () => {
        terminated = true;
      },
    }),
    "standalone"
  );
  assert.equal(terminated, false);
  action!();
  assert.equal(terminated, true);
});
