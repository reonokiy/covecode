import * as NodeCrypto from "node:crypto";
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
  readonly directMultiaddrs?: readonly string[];
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
      if (mode === "p2p") {
        const direct = (options.directMultiaddrs ?? [])
          .filter(
            (address) =>
              !address.includes("/p2p-circuit") && address.endsWith(`/p2p/${targetPeer}`),
          )
          .map((address) => multiaddr(address));
        if (direct.length) {
          try {
            return await node.dial(direct, { signal: AbortSignal.timeout(2000) });
          } catch (error) {
            lastError = error;
          }
        }
      }
      for (const relayAddr of options.relayMultiaddrs) {
        const circuitAddr = buildCircuitTargetMultiaddr(relayAddr, options.targetPeerId);
        try {
          return await node.dial(multiaddr(circuitAddr), { signal: AbortSignal.timeout(10_000) });
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

  const prefix = `/.cove-tunnel/${NodeCrypto.randomUUID().replaceAll("-", "")}`;
  const localSockets = new Set<NodeNet.Socket>();
  const allowed = (req: NodeHttp.IncomingMessage) =>
    req.headers.host === authority && req.url?.startsWith(prefix + "/");
  const server = NodeHttp.createServer((req, res) => {
    if (!allowed(req)) {
      res.writeHead(404).end();
      return;
    }
    void openTargetStream()
      .then((stream) =>
        proxyHttpRequestOverStream({
          stream,
          req,
          res,
          stripPathPrefix: prefix,
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

  server.on("connection", (socket) => {
    localSockets.add(socket);
    socket.once("close", () => localSockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    if (!allowed(req)) {
      socket.destroy();
      return;
    }
    void openTargetStream()
      .then((stream) =>
        proxyUpgradeOverStream({
          stream,
          req,
          socket,
          head,
          stripPathPrefix: prefix,
        }),
      )
      .catch(() => {
        writeUpgradeErrorResponse(socket, 502, "P2P Proxy Unavailable");
      });
  });

  let authority = "";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.listenPort ?? 0, options.listenHost ?? "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  }).catch(async (error) => {
    await node.stop();
    throw error;
  });

  const address = server.address() as NodeNet.AddressInfo | null;
  if (!address) {
    await node.stop();
    throw new Error("Failed to bind local P2P proxy HTTP server");
  }

  const host = address.address === "::" ? "127.0.0.1" : address.address;
  authority = `${host}:${address.port}`;
  const httpBaseUrl = `http://${authority}${prefix}`;
  const wsBaseUrl = `ws://${authority}${prefix}`;

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
      for (const socket of localSockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await node.stop();
    },
  };
}
