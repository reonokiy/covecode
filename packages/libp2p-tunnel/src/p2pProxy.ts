import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { dcutr } from "@libp2p/dcutr";
import { identify, identifyPush } from "@libp2p/identify";
import type { Connection, Libp2p, PrivateKey, Stream } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { tcp } from "@libp2p/tcp";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";

import {
  proxyHttpRequestOverStream,
  proxyUpgradeOverStream,
  writeUpgradeErrorResponse,
} from "./httpBridge.ts";
import {
  COVE_TUNNEL_PROTOCOL,
  loadOrCreateLibp2pPrivateKey,
  type TunnelTransportMode,
} from "./protocols.ts";

export interface ClientLibp2pProxyOptions {
  readonly relayMultiaddrs: readonly string[];
  readonly targetPeerId: string;
  readonly mode?: TunnelTransportMode;
  readonly listenHost?: string;
  readonly listenPort?: number;
  readonly privateKey?: PrivateKey;
}

export type ActiveProxyTransport = "direct" | "relay" | "disconnected";

export interface ClientLibp2pProxy {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly peerId: string;
  readonly mode: TunnelTransportMode;
  connect: () => Promise<ActiveProxyTransport>;
  getActiveTransport: () => ActiveProxyTransport;
  stop: () => Promise<void>;
}

function buildCircuitTargetMultiaddr(relayAddr: string, targetPeerId: string): string {
  const cleaned = relayAddr.replace(/\/+$/gu, "");
  return `${cleaned}/p2p-circuit/p2p/${targetPeerId}`;
}

export async function createClientLibp2pProxy(
  options: ClientLibp2pProxyOptions,
): Promise<ClientLibp2pProxy> {
  if (options.relayMultiaddrs.length === 0) {
    throw new Error("At least one relay multiaddr is required to create the libp2p client proxy");
  }

  const mode: TunnelTransportMode = options.mode ?? "p2p";
  const targetPeer = peerIdFromString(options.targetPeerId);
  const privateKey = options.privateKey ?? (await loadOrCreateLibp2pPrivateKey());

  const node: Libp2p = await createLibp2p({
    privateKey,
    ...(mode === "p2p" ? { addresses: { listen: ["/ip4/0.0.0.0/tcp/0"] } } : {}),
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
      ...(mode === "p2p" ? { dcutr: dcutr() } : {}),
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
    const open = node.getConnections(targetPeer).filter((conn) => conn.status === "open");
    if (open.length === 0) return "disconnected";
    if (mode === "p2p" && open.some((conn) => conn.direct && conn.limits === undefined)) {
      return "direct";
    }
    return "relay";
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
      for (const relayAddr of options.relayMultiaddrs) {
        const circuitAddr = buildCircuitTargetMultiaddr(relayAddr, options.targetPeerId);
        try {
          return await node.dial(multiaddr(circuitAddr));
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

  const openTargetStream = async (): Promise<Stream> => {
    const conn = await ensureConnection();
    return conn.newStream(COVE_TUNNEL_PROTOCOL, {
      runOnLimitedConnection: true,
    });
  };

  const server = NodeHttp.createServer((req, res) => {
    void openTargetStream()
      .then((stream) =>
        proxyHttpRequestOverStream({
          stream,
          req,
          res,
        }),
      )
      .catch((error) => {
        if (!res.headersSent && !res.writableEnded) {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: "p2p_proxy_unavailable",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      });
  });

  server.on("upgrade", (req, socket, head) => {
    void openTargetStream()
      .then((stream) =>
        proxyUpgradeOverStream({
          stream,
          req,
          socket,
          head,
        }),
      )
      .catch(() => {
        writeUpgradeErrorResponse(socket, 502, "P2P Proxy Unavailable");
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.listenPort ?? 0, options.listenHost ?? "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as NodeNet.AddressInfo | null;
  if (!address) {
    await node.stop();
    throw new Error("Failed to bind local P2P proxy HTTP server");
  }

  const host = address.address === "::" ? "127.0.0.1" : address.address;
  const httpBaseUrl = `http://${host}:${address.port}`;
  const wsBaseUrl = `ws://${host}:${address.port}`;

  return {
    httpBaseUrl,
    wsBaseUrl,
    peerId: node.peerId.toString(),
    mode,
    connect: async () => {
      await ensureConnection();
      return getActiveTransport();
    },
    getActiveTransport,
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await node.stop();
    },
  };
}
