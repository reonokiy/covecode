import { raceSignal } from "race-signal";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Connection } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { CODE_P2P, multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { BROWSER_TUNNEL_PROTOCOL, framedStream } from "./browserProtocol.ts";
import { peerHttpClient } from "./peerHttpClient.ts";

export async function openBrowserTunnel(input: {
  peerId: string;
  direct: readonly string[];
  relays: readonly string[];
  refreshDirect?: (signal: AbortSignal) => Promise<readonly string[]>;
}) {
  const peer = peerIdFromString(input.peerId);
  const browserAddresses = (addresses: readonly string[]) =>
    addresses
      .filter((a) => a.endsWith(`/p2p/${peer}`) && /\/(?:wss|ws|webrtc-direct)(?:\/|$)/u.test(a))
      .slice(0, 16)
      .map((addr) => multiaddr(addr));
  function addresses(hints: { direct: readonly string[]; relays: readonly string[] }) {
    const circuit = hints.relays
      .filter((addr) => /\/(?:ws|wss)(?:\/|$)/u.test(addr))
      .map((addr) => addr.replace(/\/$/u, "") + "/p2p-circuit");
    const direct = [
      ...browserAddresses(hints.direct),
      ...circuit.map((addr) => multiaddr(`${addr}/webrtc/p2p/${peer}`)),
    ];
    const relayed = circuit.map((addr) => multiaddr(`${addr}/p2p/${peer}`));
    const relayNodes = circuit.map((addr) => multiaddr(addr.slice(0, -"/p2p-circuit".length)));
    return { direct, relayed, relayNodes };
  }
  let { direct, relayed, relayNodes } = addresses(input);
  if (direct.length === 0 && relayed.length === 0 && !input.refreshDirect) {
    throw new Error("No browser-accessible tunnel address");
  }
  const node = await createLibp2p({
    transports: [webSockets(), webRTC(), webRTCDirect(), circuitRelayTransport()],
    ...(input.relays.length === 0
      ? {
          connectionGater: {
            denyDialMultiaddr: (address) =>
              ![...direct, ...relayNodes, ...relayed].some(
                (hint) => hint.equals(address) || hint.decapsulateCode(CODE_P2P).equals(address),
              ),
          },
        }
      : {}),
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
  const lifetime = new AbortController();
  let dialing: Promise<Connection> | undefined;
  let upgrading: Promise<unknown> | undefined;
  let lastAttempt = 0;
  async function tryDirect() {
    lastAttempt = Date.now();
    return node.dial(direct, {
      force: true,
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(3500)]),
    });
  }
  function connect(): Promise<Connection> {
    const connections = node.getConnections(peer).filter((c) => c.status === "open");
    const preferred = connections.find((c) => c.direct);
    if (preferred) return Promise.resolve(preferred);
    if (connections[0]) {
      if (direct.length && !upgrading && Date.now() - lastAttempt > 30_000)
        upgrading = tryDirect()
          .catch(() => {})
          .finally(() => {
            upgrading = undefined;
          });
      return Promise.resolve(connections[0]);
    }
    dialing ??= (async () => {
      if (direct.length > 0) {
        try {
          return await tryDirect();
        } catch (error) {
          if (relayed.length === 0 && !input.refreshDirect) throw error;
        }
      }
      if (relayed.length === 0 && input.refreshDirect) {
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(4000)]);
        const previous = direct;
        const discovered = await input.refreshDirect(signal);
        if (direct === previous) direct = browserAddresses(discovered);
        if (!direct.length) throw new Error("No browser-accessible address for the paired peer");
        return tryDirect();
      }
      return node.dial(relayed, {
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]),
      });
    })().finally(() => {
      dialing = undefined;
    });
    return dialing;
  }
  try {
    await connect();
  } catch (error) {
    lifetime.abort();
    await node.stop();
    throw error;
  }
  return {
    updateAddresses(hints: { direct: readonly string[]; relays: readonly string[] }) {
      ({ direct, relayed, relayNodes } = addresses(hints));
    },
    getActiveTransport: () => {
      const open = node.getConnections(peer).filter((connection) => connection.status === "open");
      return open.some((connection) => connection.direct)
        ? "direct"
        : open.length
          ? "relay"
          : "disconnected";
    },
    ...peerHttpClient(async (signal) => {
      signal.throwIfAborted();
      const conn = await raceSignal(connect(), signal);
      if (!conn.remotePeer.equals(peer)) throw new Error("Unexpected environment peer");
      const stream = await conn.newStream(BROWSER_TUNNEL_PROTOCOL, {
        runOnLimitedConnection: true,
        signal: AbortSignal.any([signal, lifetime.signal]),
      });
      return {
        ...framedStream(stream),
        transport: conn.direct ? ("direct" as const) : ("relay" as const),
      };
    }),
    async close() {
      lifetime.abort();
      await node.stop();
    },
  };
}
