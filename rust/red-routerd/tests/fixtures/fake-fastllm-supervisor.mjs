#!/usr/bin/env node
// CI-only stand-in for lifecycle testing. It never forwards a request.
import { createServer } from "node:http";

const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const response = await fetch(value("--control-url"), {
  headers: { authorization: `Bearer ${process.env.FASTLLM_PROXY_TOKEN}`, "x-redrouter-memory-only": "1" },
});
if (!response.ok) process.exit(1);
const snapshot = await response.json();
createServer((req, res) => {
  if (req.url !== "/health") { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ snapshot_version: snapshot.version }));
}).listen(Number(value("--port")), "127.0.0.1");
