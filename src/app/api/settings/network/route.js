import { NextResponse } from "next/server";
import { NETWORK_MODES, RESTART_EXIT_CODE, networkStatus, writeNetworkMode } from "@/lib/networkAccess.js";

export async function GET() {
  return NextResponse.json(networkStatus());
}

// Body: { mode: "local" | "network", restart?: boolean }. With restart, and when the
// CLI launcher runs this server, the server exits after answering and the
// launcher starts it again on the new address.
export async function PUT(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Object.hasOwn(NETWORK_MODES, body?.mode)) {
    return NextResponse.json({ error: `mode must be one of: ${Object.keys(NETWORK_MODES).join(", ")}` }, { status: 400 });
  }
  writeNetworkMode(body.mode);
  const status = networkStatus();
  const restarting = body.restart === true && status.canRestart && status.pending;
  if (restarting) setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
  return NextResponse.json({ ...status, restarting });
}
