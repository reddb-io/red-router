import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import test from "node:test";
import { findListeningPids, findPortConflictPids } from "../../../bin/cli/utils/pid.mjs";

test(
  "browser-like client sockets do not own the listener or block restarting a stopped server",
  { timeout: 15000 },
  async (t) => {
    if (process.platform === "win32") return t.skip("POSIX lsof regression");
    try {
      execFileSync("lsof", ["-v"], { stdio: "ignore" });
    } catch {
      return t.skip("lsof is unavailable");
    }
    const server = createServer();
    t.after(() => server.close());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const connection = once(server, "connection");
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import {connect} from "node:net";
    const socket=connect({port:Number(process.env.REDROUTER_FIXTURE_PORT),host:"127.0.0.1",allowHalfOpen:true});
    socket.on("connect",()=>process.stdout.write("ready\\n"));
    socket.on("end",()=>process.stdout.write("half-closed\\n"));
    socket.on("error",()=>process.exit(1));
  `,
      ],
      {
        env: { ...process.env, REDROUTER_FIXTURE_PORT: String(port) },
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    t.after(() => child.kill("SIGTERM"));
    const ready = once(child.stdout!, "data");
    const [accepted] = await connection;
    t.after(() => accepted.destroy());
    await ready;
    const listeners = await findListeningPids(port);
    assert.ok(listeners.includes(process.pid));
    assert.ok(!listeners.includes(child.pid), "an established client must not count as a listener");
    const halfClosed = once(child.stdout!, "data");
    const closed = once(server, "close");
    server.close();
    accepted.end();
    await halfClosed;
    accepted.destroy();
    await closed;
    assert.deepEqual(await findListeningPids(port), []);
    assert.deepEqual(await findPortConflictPids(port), []);
  }
);
