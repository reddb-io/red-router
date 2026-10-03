import { createServer } from "node:http";
import {
  applyNetworkAccess,
  readNetworkAccessStatus,
} from "../../../src/lib/runtime/networkAccess.ts";
import { requestServerRestart } from "../../../src/lib/runtime/serverRestart.ts";
const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/restart") {
      const mode = await requestServerRestart();
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status: "restarting", mode }));
      return;
    }
    if (request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const { mode } = JSON.parse(body);
      if (mode !== "local" && mode !== "lan") {
        response.writeHead(400).end();
        return;
      }
      await applyNetworkAccess(mode);
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ...(await readNetworkAccessStatus()), pid: process.pid }));
  } catch {
    response.writeHead(500).end("fixture failed");
  }
});
server.listen(Number(process.env.PORT), process.env.RED_ROUTER_SERVER_HOST);
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
