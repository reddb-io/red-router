/**
 * Orchestration for the WireGuard ingress routes: joins the encrypted store, the pure renderers and
 * the status probe. Nothing returned from here contains the server private key or a preshared key,
 * except `buildServerConfDownload()` (the authenticated file download) and the one-time peer file
 * from `createPeerConfig()`.
 */

import {
  addWireGuardPeer,
  readWireGuardConfig,
  readWireGuardServerConfSource,
  removeWireGuardPeer,
  type StoredWireGuardConfig,
} from "@/lib/db/wireguardServerConfig";
import {
  peerEndpointFor,
  renderPeerConf,
  renderServerConf,
  type WireGuardPeer,
} from "@/lib/wireguard/serverConfig";
import { getWireGuardStatus, type WireGuardStatus } from "@/lib/wireguard/status";
import { peerFileSlug } from "@/shared/validation/wireguardSchemas";

/** Shown next to the one-time peer file, and returned in the API response text. */
export const PEER_PRIVATE_KEY_NOTICE =
  "This is the only time this peer's private key is shown. RedRouter does not store it, so save or import this file now. If it is lost, delete the peer and add it again.";

export type PublicWireGuardPeer = {
  id: string;
  name: string;
  publicKey: string;
  allowedIp: string;
  createdAt: string;
  hasPresharedKey: boolean;
};

export type PublicWireGuardConfig = {
  interfaceName: string;
  address: string;
  listenPort: number;
  endpointHost: string;
  dns: string;
  serverPublicKey: string;
  peers: PublicWireGuardPeer[];
};

export function toPublicPeer(peer: WireGuardPeer): PublicWireGuardPeer {
  return {
    id: peer.id,
    name: peer.name,
    publicKey: peer.publicKey,
    allowedIp: peer.allowedIp,
    createdAt: peer.createdAt,
    hasPresharedKey: peer.hasPresharedKey === true,
  };
}

/** The stored model as the API returns it: public keys only. */
export function toPublicConfig(config: StoredWireGuardConfig): PublicWireGuardConfig {
  return {
    interfaceName: config.interfaceName,
    address: config.address,
    listenPort: config.listenPort,
    endpointHost: config.endpointHost,
    dns: config.dns,
    serverPublicKey: config.serverPublicKey,
    peers: config.peers.map(toPublicPeer),
  };
}

export function getWireGuardOverview(): { config: PublicWireGuardConfig | null; status: WireGuardStatus } {
  const stored = readWireGuardConfig();
  return {
    config: stored ? toPublicConfig(stored) : null,
    status: getWireGuardStatus(stored),
  };
}

export type CreatedPeerConfig = {
  peer: PublicWireGuardPeer;
  /** The complete peer file, including its private key. Shown once. */
  config: string;
  filename: string;
  notice: string;
};

/**
 * Add a peer and render its file. The private key exists only in the returned `config` text; if
 * rendering fails the peer is removed again, so no half-created peer is left without a usable file.
 */
export function createPeerConfig(input: { name: string; usePresharedKey: boolean }): CreatedPeerConfig {
  const added = addWireGuardPeer(input);
  try {
    const config = renderPeerConf({
      peerPrivateKey: added.peerPrivateKey,
      peerAddress: added.peer.allowedIp,
      serverAddress: added.config.address,
      serverPublicKey: added.config.serverPublicKey,
      endpoint: peerEndpointFor(added.config),
      presharedKey: added.presharedKey,
      dns: added.config.dns,
      name: added.peer.name,
    });
    return {
      peer: toPublicPeer(added.peer),
      config,
      filename: `${peerFileSlug(added.peer.name)}.conf`,
      notice: PEER_PRIVATE_KEY_NOTICE,
    };
  } catch (error) {
    removeWireGuardPeer(added.peer.id);
    throw error;
  }
}

/** The server file for download, or null when nothing is configured or the key is unreadable. */
export function buildServerConfDownload(): { filename: string; body: string } | null {
  const source = readWireGuardServerConfSource();
  if (!source) return null;
  return {
    filename: `${source.model.interfaceName}.conf`,
    body: renderServerConf(source.model, source.serverPrivateKey),
  };
}
