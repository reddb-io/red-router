/**
 * WireGuard egress orchestration: profiles (database) + wireproxy processes + the outbound-proxy
 * registry.
 *
 * Registry linkage. Every profile owns one registry proxy: type `socks5`, host `127.0.0.1`, the
 * profile's loopback port, the per-profile SOCKS credentials, `source = "wireguard-egress"`
 * (managed: the generic registry paths refuse to edit or delete it). Operators assign that proxy
 * to connections, providers, combos or globally like any other.
 *
 * Fail closed. The registry row is `active` ONLY while the process is `running`; in every other
 * state (stopped, starting, crashed, disabled) it is `inactive`, and it is marked inactive BEFORE a
 * process is stopped on purpose. The registry treats an assigned-but-inactive proxy as a blocking
 * assignment (`hasBlockingProxyAssignment*` in `db/proxies/guards.ts`, #6246/#7380/#13469): the
 * request is refused instead of silently going direct. Deleting a profile that is still assigned
 * is refused (409) unless forced, because a forced registry delete drops the assignments and the
 * affected traffic would then egress directly.
 */

import { readdir } from "fs/promises";
import path from "path";
import {
  createProxy,
  deleteProxyById,
  getProxyById,
  getProxyWhereUsed,
  updateProxy,
} from "@/lib/db/proxies";
import {
  EgressProfileError,
  createWireGuardEgressProfile,
  deleteWireGuardEgressProfile,
  getWireGuardEgressProfile,
  listWireGuardEgressPorts,
  listWireGuardEgressProfiles,
  readWireGuardEgressModel,
  readWireGuardEgressSecrets,
  updateWireGuardEgressProfile,
  type WireGuardEgressProfile,
} from "@/lib/db/wireguardEgress";
import { WIREGUARD_EGRESS_PROXY_SOURCE } from "@/shared/constants/managedProxySources";
import {
  parseWireGuardEgressConfig,
  renderWireproxyConfig,
  type WgIgnoredLine,
} from "./egressConfig";
import {
  forgetEgressProcess,
  getEgressProcessStatus,
  getWireGuardEgressRuntime,
  onEgressStateChange,
  restartEgressProcess,
  startEgressProcess,
  stopAllEgressProcesses,
  stopEgressProcess,
  type EgressProcessStatus,
  type EgressSpec,
} from "./egressProcess";

export type EgressServiceErrorCode =
  "not_found" | "config_invalid" | "duplicate_name" | "limit_reached" | "invalid_name" | "in_use";

export class EgressServiceError extends Error {
  code: EgressServiceErrorCode;
  /** Parser messages: fixed sentences with line numbers, never input text. */
  details: string[];
  constructor(code: EgressServiceErrorCode, details: string[] = []) {
    super(code);
    this.name = "EgressServiceError";
    this.code = code;
    this.details = details;
  }
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof EgressProfileError) throw new EgressServiceError(error.code);
    throw error;
  }
}

export type WireGuardEgressView = WireGuardEgressProfile & {
  status: Pick<EgressProcessStatus, "phase" | "pid" | "lastError" | "restarts" | "retryInMs">;
  proxy: { id: string; status: string } | null;
};

// --- registry linkage ---------------------------------------------------------------------------

type RegistryStatus = "active" | "inactive";

/** Serialises registry status writes per profile so a quick running -> error flip cannot reorder. */
const chains = new Map<string, Promise<void>>();
const applied = new Map<string, RegistryStatus>();

async function clearDispatchers(): Promise<void> {
  try {
    const { clearDispatcherCache } = await import("@omniroute/open-sse/utils/proxyDispatcher");
    clearDispatcherCache();
  } catch {
    /* the cache is best effort; a stale dispatcher still points at the same loopback port */
  }
}

function queue(id: string, task: () => Promise<void>): Promise<void> {
  const previous = chains.get(id) ?? Promise.resolve();
  const next = previous.then(task, task).catch(() => {});
  chains.set(id, next);
  return next;
}

/** Create or refresh the profile's registry proxy with the given status. Returns its id. */
async function syncRegistryProxy(id: string, status: RegistryStatus): Promise<string | null> {
  let proxyId: string | null = null;
  await queue(id, async () => {
    const profile = getWireGuardEgressProfile(id);
    const secrets = readWireGuardEgressSecrets(id);
    if (!profile || !secrets) return;
    const payload = {
      name: `WireGuard: ${profile.name}`,
      type: "socks5",
      host: "127.0.0.1",
      port: profile.socksPort,
      username: secrets.socksUsername,
      password: secrets.socksPassword,
      notes: "Managed by RedRouter WireGuard egress. Active only while the tunnel is running.",
      status,
      source: WIREGUARD_EGRESS_PROXY_SOURCE,
      family: "auto",
    };
    const existing = profile.proxyId ? await getProxyById(profile.proxyId) : null;
    if (existing) {
      await updateProxy(existing.id, payload, { allowManaged: true });
      proxyId = existing.id;
    } else {
      const created = await createProxy(payload);
      if (!created?.id) return;
      proxyId = created.id;
      updateWireGuardEgressProfile(id, { proxyId });
    }
    applied.set(id, status);
    await clearDispatchers();
  });
  return proxyId;
}

/** Flip only the status of an existing registry proxy. No-op when it already has that status. */
async function setRegistryStatus(id: string, status: RegistryStatus): Promise<void> {
  await queue(id, async () => {
    const profile = getWireGuardEgressProfile(id);
    if (!profile?.proxyId) return;
    if (applied.get(id) === status) return;
    const updated = await updateProxy(profile.proxyId, { status }, { allowManaged: true });
    if (updated) {
      applied.set(id, status);
      await clearDispatchers();
    }
  });
}

let wired = false;
function wireProcessEvents(): void {
  if (wired) return;
  wired = true;
  onEgressStateChange((status) => {
    const desired: RegistryStatus = status.phase === "running" ? "active" : "inactive";
    void setRegistryStatus(status.id, desired);
  });
}

// --- specs and ports ----------------------------------------------------------------------------

function specFor(profile: WireGuardEgressProfile): EgressSpec {
  const id = profile.id;
  return {
    id,
    socksPort: profile.socksPort,
    loadConfig: () => {
      const stored = readWireGuardEgressModel(id);
      if (!stored) throw new Error("profile missing");
      return renderWireproxyConfig(stored.model, {
        socksPort: stored.socksPort,
        socksUsername: stored.socksUsername,
        socksPassword: stored.socksPassword,
      });
    },
  };
}

async function pickPort(exclude: number[] = []): Promise<number> {
  const runtime = getWireGuardEgressRuntime();
  const taken = new Set([...listWireGuardEgressPorts(), ...exclude]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await runtime.findFreePort();
    if (!taken.has(port)) return port;
  }
  throw new Error("no free port");
}

/** A saved port that something else now listens on is replaced before the process starts. */
async function ensureUsablePort(profile: WireGuardEgressProfile): Promise<WireGuardEgressProfile> {
  const runtime = getWireGuardEgressRuntime();
  const own = getEgressProcessStatus(profile.id);
  if (own.phase === "running" || own.phase === "starting") return profile;
  if (!(await runtime.probePort(profile.socksPort, 300))) return profile;
  const port = await pickPort([profile.socksPort]);
  return wrap(() => updateWireGuardEgressProfile(profile.id, { socksPort: port })) ?? profile;
}

// --- public API ---------------------------------------------------------------------------------

function view(profile: WireGuardEgressProfile, proxyStatus: string | null): WireGuardEgressView {
  const status = getEgressProcessStatus(profile.id);
  return {
    ...profile,
    status: {
      phase: status.phase,
      pid: status.pid,
      lastError: status.lastError,
      restarts: status.restarts,
      retryInMs: status.retryInMs,
    },
    proxy: profile.proxyId && proxyStatus ? { id: profile.proxyId, status: proxyStatus } : null,
  };
}

export async function listEgressProfiles(): Promise<WireGuardEgressView[]> {
  const out: WireGuardEgressView[] = [];
  for (const profile of listWireGuardEgressProfiles()) {
    const proxy = profile.proxyId ? await getProxyById(profile.proxyId) : null;
    out.push(view(profile, proxy?.status ?? null));
  }
  return out;
}

export async function getEgressProfile(id: string): Promise<WireGuardEgressView | null> {
  const profile = getWireGuardEgressProfile(id);
  if (!profile) return null;
  const proxy = profile.proxyId ? await getProxyById(profile.proxyId) : null;
  return view(profile, proxy?.status ?? null);
}

export type CreateEgressResult = {
  profile: WireGuardEgressView;
  ignored: WgIgnoredLine[];
  warnings: string[];
};

/**
 * Parse, validate and store a pasted wg-quick config. The text is not kept: only the parsed
 * fields, with the keys encrypted. The profile is created stopped and disabled; enabling it is a
 * separate, explicit action.
 */
export async function createEgressProfile(input: {
  name: string;
  config: string;
}): Promise<CreateEgressResult> {
  const parsed = parseWireGuardEgressConfig(input.config);
  if (!parsed.ok || !parsed.model) throw new EgressServiceError("config_invalid", parsed.errors);
  const socksPort = await pickPort();
  const profile = wrap(() =>
    createWireGuardEgressProfile({ name: input.name, model: parsed.model!, socksPort })
  );
  return {
    profile: (await getEgressProfile(profile.id)) as WireGuardEgressView,
    ignored: parsed.ignored,
    warnings: parsed.warnings,
  };
}

/** Enable: create/refresh the (inactive) registry proxy, start the tunnel, activate on ready. */
export async function enableEgressProfile(id: string): Promise<WireGuardEgressView> {
  wireProcessEvents();
  let profile = getWireGuardEgressProfile(id);
  if (!profile) throw new EgressServiceError("not_found");
  wrap(() => updateWireGuardEgressProfile(id, { enabled: true }));
  profile = await ensureUsablePort(profile);
  const alreadyRunning = getEgressProcessStatus(id).phase === "running";
  await syncRegistryProxy(id, alreadyRunning ? "active" : "inactive");
  const fresh = getWireGuardEgressProfile(id) as WireGuardEgressProfile;
  const status = await startEgressProcess(specFor(fresh));
  await setRegistryStatus(id, status.phase === "running" ? "active" : "inactive");
  return (await getEgressProfile(id)) as WireGuardEgressView;
}

/** Disable: mark the proxy inactive FIRST (so nothing routes to a dying port), then stop. */
export async function disableEgressProfile(id: string): Promise<WireGuardEgressView> {
  wireProcessEvents();
  if (!getWireGuardEgressProfile(id)) throw new EgressServiceError("not_found");
  wrap(() => updateWireGuardEgressProfile(id, { enabled: false }));
  await setRegistryStatus(id, "inactive");
  await stopEgressProcess(id);
  await setRegistryStatus(id, "inactive");
  return (await getEgressProfile(id)) as WireGuardEgressView;
}

export async function restartEgressProfile(id: string): Promise<WireGuardEgressView> {
  wireProcessEvents();
  const profile = getWireGuardEgressProfile(id);
  if (!profile) throw new EgressServiceError("not_found");
  wrap(() => updateWireGuardEgressProfile(id, { enabled: true }));
  await setRegistryStatus(id, "inactive");
  await syncRegistryProxy(id, "inactive");
  const status = await restartEgressProcess(
    specFor(getWireGuardEgressProfile(id) as WireGuardEgressProfile)
  );
  await setRegistryStatus(id, status.phase === "running" ? "active" : "inactive");
  return (await getEgressProfile(id)) as WireGuardEgressView;
}

/**
 * Delete a profile, its secrets and its registry proxy. Refused (409) while the proxy is still
 * assigned anywhere, unless `force`: forcing drops those assignments and the affected traffic then
 * egresses directly, so the caller must mean it.
 */
export async function deleteEgressProfile(
  id: string,
  options: { force?: boolean } = {}
): Promise<void> {
  wireProcessEvents();
  const profile = getWireGuardEgressProfile(id);
  if (!profile) throw new EgressServiceError("not_found");
  if (profile.proxyId && !options.force) {
    const usage = await getProxyWhereUsed(profile.proxyId);
    if (usage.count > 0) throw new EgressServiceError("in_use");
  }
  await setRegistryStatus(id, "inactive");
  await stopEgressProcess(id);
  forgetEgressProcess(id);
  if (profile.proxyId && (await getProxyById(profile.proxyId))) {
    await deleteProxyById(profile.proxyId, { force: true, allowManaged: true });
    await clearDispatchers();
  }
  deleteWireGuardEgressProfile(id);
  applied.delete(id);
  chains.delete(id);
}

async function removeStaleRuntimeFiles(): Promise<void> {
  const dir = getWireGuardEgressRuntime().runtimeDir();
  try {
    for (const name of await readdir(dir)) {
      if (name.endsWith(".conf"))
        await getWireGuardEgressRuntime().fs.removeFile(path.join(dir, name));
    }
  } catch {
    /* no runtime dir yet */
  }
}

/**
 * Server start: every registry proxy is made inactive first (fail closed), stale key files from a
 * crashed run are removed, then enabled profiles are started. Never throws.
 */
export async function restoreWireGuardEgress(): Promise<void> {
  try {
    wireProcessEvents();
    await removeStaleRuntimeFiles();
    for (const profile of listWireGuardEgressProfiles()) {
      if (profile.proxyId) await setRegistryStatus(profile.id, "inactive");
    }
    for (const profile of listWireGuardEgressProfiles()) {
      if (!profile.enabled) continue;
      try {
        await enableEgressProfile(profile.id);
      } catch (error) {
        console.error("[wireguard-egress] restore failed for a profile", (error as Error)?.name);
      }
    }
  } catch (error) {
    console.error("[wireguard-egress] restore failed", (error as Error)?.name);
  }
}

/** Server shutdown: stop every tunnel and let the registry writes drain. Never throws. */
export async function shutdownWireGuardEgress(): Promise<void> {
  try {
    await stopAllEgressProcesses();
    await Promise.all([...chains.values()]);
  } catch {
    /* shutting down */
  }
}
