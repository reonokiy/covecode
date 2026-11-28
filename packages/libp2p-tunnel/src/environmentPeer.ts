import { raceSignal } from "race-signal";
import * as NodeEvents from "node:events";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { dcutr } from "@libp2p/dcutr";
import { identify, identifyPush } from "@libp2p/identify";
import type { Connection, Libp2p, PeerInfo, PrivateKey, Stream } from "@libp2p/interface";
import { mdns } from "@libp2p/mdns";
import { peerIdFromString } from "@libp2p/peer-id";
import { tcp } from "@libp2p/tcp";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";

import {
  COVE_TUNNEL_PROTOCOL,
  HTTP_OVER_LIBP2P,
  loadOrCreateLibp2pPrivateKey,
  type TunnelTransportMode,
} from "./protocols.ts";

export interface EnvironmentPeerOptions {
  readonly relayMultiaddrs: readonly string[];
  readonly targetPeerId: string;
  readonly directMultiaddrs?: readonly string[];
  readonly lanDiscovery?: boolean;
  readonly mode?: TunnelTransportMode;
  readonly privateKey?: PrivateKey;
}

export type ActiveProxyTransport = "direct" | "relay" | "disconnected";

function buildCircuitTargetMultiaddr(relayAddr: string, targetPeerId: string): string {
  const cleaned = relayAddr.replace(/\/+$/gu, "");
  return `${cleaned}/p2p-circuit/p2p/${targetPeerId}`;
}

export async function openEnvironmentPeer(options: EnvironmentPeerOptions) {
  const lan = options.lanDiscovery ?? options.relayMultiaddrs.length === 0;
  const discoverLan = lan || options.relayMultiaddrs.length === 0;
  let directHints = options.directMultiaddrs ?? [];
  let relayHints = options.relayMultiaddrs;
  const mode: TunnelTransportMode = options.mode ?? "p2p";
  const targetPeer = peerIdFromString(options.targetPeerId);
  const privateKey = options.privateKey ?? (await loadOrCreateLibp2pPrivateKey());

  const changes = new EventTarget();
  let discovered: string[] = [];
  const lifetime = new AbortController();
  const node: Libp2p = await createLibp2p({
    privateKey,
    ...(lan ? { connectionGater: { denyDialPeer: (peer) => !peer.equals(targetPeer) } } : {}),
    ...(discoverLan
      ? {
          peerDiscovery: [
            (components) => {
              const discovery = mdns({ broadcast: false })(components);
              discovery.addEventListener("peer", ({ detail }: CustomEvent<PeerInfo>) => {
                if (!detail.id.equals(targetPeer)) return;
                discovered = detail.multiaddrs.map((addr) =>
                  addr.encapsulate(`/p2p/${targetPeer}`).toString(),
                );
                changes.dispatchEvent(new Event("address"));
              });
              return discovery;
            },
          ],
        }
      : {}),
    ...(mode === "p2p" && !lan ? { addresses: { listen: ["/ip4/0.0.0.0/tcp/0"] } } : {}),
    transports: [
      webSockets(),
      tcp(),
      circuitRelayTransport({
        reservationCompletionTimeout: 10_000,
      }),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      identifyPush: identifyPush(),
      ...(mode === "p2p" && !lan ? { dcutr: dcutr() } : {}),
    },
  });

  const selectPreferredConnection = (): Connection | undefined => {
    const open = node.getConnections(targetPeer).filter((conn) => conn.status === "open");
    if (open.length === 0) return undefined;
    if (mode === "p2p") {
      const direct = open.find((conn) => conn.direct && conn.limits === undefined);
      if (direct) return direct;
    }
    return open[0];
  };

  const getActiveTransport = (): ActiveProxyTransport => {
    const selected = selectPreferredConnection();
    if (!selected) return "disconnected";
    return selected.direct ? "direct" : "relay";
  };

  let pendingDial: Promise<Connection> | null = null;

  const ensureConnection = async (): Promise<Connection> => {
    const existing = selectPreferredConnection();
    if (existing) return existing;

    if (pendingDial !== null) {
      return pendingDial;
    }

    pendingDial = (async () => {
      let lastError: unknown;
      if (mode === "p2p" || lan) {
        const waitForDiscovery = discoverLan && !relayHints.length;
        const signal = waitForDiscovery
          ? AbortSignal.any([lifetime.signal, AbortSignal.timeout(12_000)])
          : lifetime.signal;
        while (!signal.aborted) {
          const known = discovered;
          const hints = directHints;
          const candidates = [...new Set([...known, ...hints])]
            .filter(
              (address) =>
                !address.includes("/p2p-circuit") && address.endsWith(`/p2p/${targetPeer}`),
            )
            .map((address) => multiaddr(address));
          if (candidates.length) {
            try {
              return await node.dial(candidates, {
                signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
              });
            } catch (error) {
              lastError = error;
            }
          }
          if (!waitForDiscovery || relayHints.length) break;
          if (known === discovered && hints === directHints)
            await NodeEvents.EventEmitter.once(changes, "address", { signal });
        }
      }
      for (const relayAddr of relayHints) {
        const circuitAddr = buildCircuitTargetMultiaddr(relayAddr, options.targetPeerId);
        try {
          return await node.dial(multiaddr(circuitAddr), {
            signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]),
          });
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(`Unable to reach peer ${options.targetPeerId} via configured relays`);
    })().finally(() => {
      pendingDial = null;
    });

    return pendingDial;
  };

  return {
    peerId: node.peerId.toString(),
    mode,
    connect: async (): Promise<ActiveProxyTransport> =>
      (await ensureConnection()).direct ? "direct" : "relay",
    getActiveTransport,
    updateAddresses(hints: { direct: readonly string[]; relays: readonly string[] }) {
      directHints = hints.direct;
      relayHints = hints.relays;
      changes.dispatchEvent(new Event("address"));
    },
    async openStream(
      signal?: AbortSignal,
      selected?: (path: "direct" | "relay") => void,
    ): Promise<Stream> {
      signal?.throwIfAborted();
      const conn = await raceSignal(ensureConnection(), signal);
      const stream = await conn.newStream([HTTP_OVER_LIBP2P, COVE_TUNNEL_PROTOCOL], {
        runOnLimitedConnection: true,
        signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
      });
      selected?.(conn.direct ? "direct" : "relay");
      return stream;
    },
    async stop() {
      lifetime.abort();
      await node.stop();
    },
  };
}
