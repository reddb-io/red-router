import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  deviceCodeResponseWithVerifier,
  qoderCnPollData,
} from "../../src/lib/oauth/qoderCnDeviceFlow.ts";

test("Qoder CN device route preserves the verifier that generated the login challenge", () => {
  const machineId = randomUUID();
  const cnVerifier = "a".repeat(43);
  const response = deviceCodeResponseWithVerifier(
    "qoder-cn",
    { codeVerifier: cnVerifier, _qoderMachineId: machineId, device_code: randomUUID() },
    "generic-verifier"
  );
  assert.equal(response.codeVerifier, cnVerifier);
  assert.equal(response._qoderMachineId, machineId);
  assert.equal(
    deviceCodeResponseWithVerifier("kiro", { device_code: "id" }, "generic-verifier").codeVerifier,
    "generic-verifier"
  );
});

test("Qoder CN polling forwards only a valid generated machine ID", () => {
  const machineId = randomUUID();
  assert.deepEqual(qoderCnPollData("qoder-cn", { _qoderMachineId: machineId, token: "secret" }), {
    _qoderMachineId: machineId,
  });
  assert.throws(() => qoderCnPollData("qoder-cn", { _qoderMachineId: "bad" }), /invalid/);
});
