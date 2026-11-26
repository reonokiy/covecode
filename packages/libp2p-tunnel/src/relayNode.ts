import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import {
  circuitRelayServer,
  circuitRelayTransport,
  type CircuitRelayService,
} from "@libp2p/circuit-relay-v2";
import { identify, identifyPush } from "@libp2p/identify";
import type { Connection, Libp2p, PeerId, PrivateKey, Stream } from "@libp2p/interface";
import { multiaddr } from "@multiformats/multiaddr";
import { peerIdFromPrivateKey, peerIdFromString } from "@libp2p/peer-id";
import { tcp } from "@libp2p/tcp";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";

import {
  proxyHttpRequestOverStream,
  proxyUpgradeOverStream,
  writeUpgradeErrorResponse,
  type HttpProxyOptions,
} from "./httpBridge.ts";
import {
  COVE_TUNNEL_PROTOCOL,
  COVE_TUNNEL_REGISTER_PROTOCOL,
  loadOrCreateLibp2pPrivateKey,
  readBoundedJsonLine,
  writeJsonLine,
} from "./protocols.ts";

export interface RelayRegistrationValidationInput {
  readonly endpointId: string;
  readonly endpointKey: string;
  readonly connectorToken: string;
  readonly remotePeerId: string;
}

export interface RelayLibp2pNodeOptions {
  readonly listenMultiaddrs?: readonly string[];
  readonly replicaMultiaddrs?: readonly string[];
  readonly announceMultiaddrs?: readonly string[];
  readonly keyPath?: string;
  readonly privateKey?: PrivateKey;
  readonly maxReservations?: number;
  readonly connectionLimits?: { readonly durationMs?: number; readonly bytes?: number };
  readonly validateRegistration: (
    input: RelayRegistrationValidationInput,
  ) => Promise<boolean> | boolean;
  readonly onEndpointReady?: (registration: RelayRegisteredEndpoint) => void | Promise<void>;
  readonly remoteRoutes?: (
    endpointKey: string,
  ) => Promise<readonly { peerId: string; addresses: readonly string[] }[]>;
  readonly onEndpointDisconnected?: (endpointKey: string) => void;
}

export interface RelayRegisteredEndpoint {
  readonly endpointKey: string;
  readonly endpointId: string;
  readonly peerId: string;
  readonly connectedAt: number;
  readonly directMultiaddrs: readonly string[];
}

interface InternalRegistrationRecord {
  clearReservationWatch?: () => void;
  readonly connection: Connection;
  readonly endpointKey: string;
  readonly endpointId: string;
  readonly peerId: PeerId;
  readonly connectedAt: number;
  readonly directMultiaddrs: readonly string[];
}

interface RegisterMessagePayload {
  readonly ready?: unknown;
  readonly endpointId?: unknown;
  readonly endpointKey?: unknown;
  readonly connectorToken?: unknown;
  readonly directMultiaddrs?: unknown;
}

export interface RelayLibp2pNode {
  readonly peerId: string;
  getMultiaddrs: () => string[];
  getEndpointRegistration: (endpointKey: string) => RelayRegisteredEndpoint | null;
  isEndpointConnected: (endpointKey: string) => boolean;
  openEndpointStream: (endpointKey: string, options?: { signal?: AbortSignal }) => Promise<Stream>;
  proxyHttpRequest: (
    endpointKey: string,
    req: NodeHttp.IncomingMessage,
    res: NodeHttp.ServerResponse,
    options?: HttpProxyOptions,
  ) => Promise<void>;
  proxyUpgrade: (
    endpointKey: string,
    req: NodeHttp.IncomingMessage,
    socket: NodeStream.Duplex,
    head: Buffer,
    options?: { readonly stripPathPrefix?: string },
  ) => Promise<void>;
  stop: () => Promise<void>;
}

export async function createRelayLibp2pNode(
  options: RelayLibp2pNodeOptions,
): Promise<RelayLibp2pNode> {
  const privateKey = options.privateKey ?? (await loadOrCreateLibp2pPrivateKey(options.keyPath));
  const listen = [...(options.listenMultiaddrs ?? ["/ip4/127.0.0.1/tcp/0/ws"])];
  let announce = options.announceMultiaddrs?.length ? [...options.announceMultiaddrs] : undefined;
  if (options.replicaMultiaddrs) {
    const self = peerIdFromPrivateKey(privateKey);
    announce = [];
    for (const raw of options.replicaMultiaddrs) {
      const addr = multiaddr(raw);
      const last = addr.getComponents().at(-1);
      if (
        last?.name !== "p2p" ||
        !last.value ||
        addr.getComponents().some((c) => c.name === "p2p-circuit")
      ) {
        throw new Error(
          "COVE_CP_LIBP2P_REPLICAS requires direct relay addresses ending in /p2p/<peer ID>",
        );
      }
      if (self.equals(peerIdFromString(last.value)))
        announce.push(addr.decapsulateCode(last.code).toString());
    }
    if (!announce.length)
      throw new Error(`COVE_CP_LIBP2P_REPLICAS must include the local peer ${self}`);
  }
  const durationMs = options.connectionLimits?.durationMs ?? 60 * 60 * 1000;
  const bytes = options.connectionLimits?.bytes ?? 1024 ** 3;
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 2_147_483_647) {
    throw new Error("Relay connection duration must be between 1 and 2147483647 milliseconds");
  }
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error("Relay connection byte limit must be a positive safe integer");
  }
  const registrations = new Map<string, InternalRegistrationRecord>();
  const isRegisteredPeer = (peer: PeerId): boolean => {
    for (const entry of registrations.values()) {
      if (entry.connection.status === "open" && entry.peerId.equals(peer)) return true;
    }
    return false;
  };

  const node: Libp2p<{
    identify: unknown;
    identifyPush: unknown;
    circuitRelay: CircuitRelayService;
  }> = await createLibp2p({
    privateKey,
    addresses: {
      listen,
      ...(announce !== undefined ? { announce } : {}),
    },
    transports: [webSockets(), tcp(), ...(options.remoteRoutes ? [circuitRelayTransport()] : [])],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyInboundRelayReservation: (peer) => !isRegisteredPeer(peer),
      denyOutboundRelayedConnection: (_client, destination) => !isRegisteredPeer(destination),
    },
    services: {
      identify: identify(),
      identifyPush: identifyPush(),
      circuitRelay: circuitRelayServer({
        reservations: {
          maxReservations: options.maxReservations ?? 1000,
          defaultDurationLimit: durationMs,
          defaultDataLimit: BigInt(bytes),
        },
      }),
    },
  });

  node.addEventListener("connection:close", ({ detail }) => {
    for (const [key, entry] of registrations.entries()) {
      if (entry.connection.id === detail.id) {
        entry.clearReservationWatch?.();
        registrations.delete(key);
        options.onEndpointDisconnected?.(key);
      }
    }
  });

  await node.handle(
    COVE_TUNNEL_REGISTER_PROTOCOL,
    async (stream, connection) => {
      try {
        const message = await readBoundedJsonLine<RegisterMessagePayload>(stream);
        const endpointId = typeof message.endpointId === "string" ? message.endpointId.trim() : "";
        const endpointKey =
          typeof message.endpointKey === "string" ? message.endpointKey.trim() : "";
        const connectorToken =
          typeof message.connectorToken === "string" ? message.connectorToken.trim() : "";

        if (message.ready === true) {
          const entry = registrations.get(endpointKey);
          const reservation = node.services.circuitRelay.reservations.get(connection.remotePeer);
          if (
            !entry ||
            entry.connection.id !== connection.id ||
            !reservation ||
            reservation.signal.aborted
          ) {
            await writeJsonLine(stream, { ok: false });
            return;
          }
          if (!entry.clearReservationWatch) {
            // Expiration without a transport disconnect must also withdraw the route and trigger re-registration.
            const expired = () => connection.abort(new Error("Circuit relay reservation expired"));
            reservation.signal.addEventListener("abort", expired, { once: true });
            entry.clearReservationWatch = () =>
              reservation.signal.removeEventListener("abort", expired);
          }
          await options.onEndpointReady?.({
            endpointKey,
            endpointId: entry.endpointId,
            peerId: entry.peerId.toString(),
            directMultiaddrs: entry.directMultiaddrs,
            connectedAt: entry.connectedAt,
          });
          await writeJsonLine(stream, { ok: true });
          return;
        }

        if (!endpointId || !endpointKey || !connectorToken) {
          await writeJsonLine(stream, { ok: false, error: "invalid_registration_payload" });
          return;
        }

        const allowed = await options.validateRegistration({
          endpointId,
          endpointKey,
          connectorToken,
          remotePeerId: connection.remotePeer.toString(),
        });
        if (!allowed) {
          await writeJsonLine(stream, { ok: false, error: "unauthorized" });
          return;
        }
        if (connection.status !== "open") return;

        const record: InternalRegistrationRecord = {
          connection,
          endpointKey,
          endpointId,
          peerId: connection.remotePeer,
          connectedAt: Date.now(),
          directMultiaddrs: Array.isArray(message.directMultiaddrs)
            ? message.directMultiaddrs
                .slice(0, 16)
                .filter(
                  (a): a is string =>
                    typeof a === "string" &&
                    a.length < 1024 &&
                    a.endsWith(`/p2p/${connection.remotePeer}`) &&
                    !a.includes("/p2p-circuit"),
                )
            : [],
        };
        const previous = registrations.get(endpointKey);
        if (previous) {
          previous.clearReservationWatch?.();
          options.onEndpointDisconnected?.(endpointKey);
        }
        registrations.set(endpointKey, record);
        await writeJsonLine(stream, { ok: true, confirmReservation: !!options.onEndpointReady });
      } catch (error) {
        stream.abort(error instanceof Error ? error : new Error(String(error)));
      }
    },
    {
      runOnLimitedConnection: true,
      maxInboundStreams: 64,
      maxOutboundStreams: 64,
    },
  );

  const openEndpointStream = async (
    endpointKey: string,
    openOptions?: { signal?: AbortSignal },
  ): Promise<Stream> => {
    const signalForAttempt = () =>
      AbortSignal.any([
        AbortSignal.timeout(4000),
        ...(openOptions?.signal ? [openOptions.signal] : []),
      ]);
    const entry = registrations.get(endpointKey);
    if (entry?.connection.status === "open") {
      try {
        return await entry.connection.newStream(COVE_TUNNEL_PROTOCOL, {
          runOnLimitedConnection: true,
          signal: signalForAttempt(),
        });
      } catch (error) {
        if (!options.remoteRoutes || openOptions?.signal?.aborted) throw error;
      }
    }
    const routes = (await options.remoteRoutes?.(endpointKey)) ?? [];
    let force = false;
    for (const route of routes) {
      const candidates = route.addresses.map((address) =>
        multiaddr(address).encapsulate(`/p2p-circuit/p2p/${route.peerId}`),
      );
      if (!candidates.length) continue;
      const signal = signalForAttempt();
      try {
        const connection = await node.dial(candidates, { signal, force });
        return await connection.newStream(COVE_TUNNEL_PROTOCOL, {
          runOnLimitedConnection: true,
          signal,
        });
      } catch (error) {
        if (openOptions?.signal?.aborted) throw error;
        force = true;
      }
    }
    throw new Error(`Tunnel endpoint "${endpointKey}" is unavailable`);
  };

  return {
    peerId: node.peerId.toString(),
    getMultiaddrs: () => node.getMultiaddrs().map((ma) => ma.toString()),
    getEndpointRegistration: (endpointKey) => {
      const entry = registrations.get(endpointKey);
      if (!entry) return null;
      return {
        endpointKey: entry.endpointKey,
        endpointId: entry.endpointId,
        peerId: entry.peerId.toString(),
        connectedAt: entry.connectedAt,
        directMultiaddrs: entry.directMultiaddrs,
      };
    },
    isEndpointConnected: (endpointKey) => {
      const entry = registrations.get(endpointKey);
      if (!entry) return false;
      return entry.connection.status === "open";
    },
    openEndpointStream,
    proxyHttpRequest: async (endpointKey, req, res, proxyOptions) => {
      let stream: Stream;
      try {
        stream = await openEndpointStream(endpointKey);
      } catch (error) {
        if (!res.headersSent && !res.writableEnded) {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: "tunnel_unavailable",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        return;
      }

      await proxyHttpRequestOverStream({
        stream,
        req,
        res,
        ...(proxyOptions?.stripPathPrefix !== undefined
          ? { stripPathPrefix: proxyOptions.stripPathPrefix }
          : {}),
        ...(proxyOptions?.onError !== undefined ? { onError: proxyOptions.onError } : {}),
      });
    },
    proxyUpgrade: async (endpointKey, req, socket, head, proxyOptions) => {
      let stream: Stream;
      try {
        stream = await openEndpointStream(endpointKey);
      } catch {
        writeUpgradeErrorResponse(socket, 502, "Tunnel Unavailable");
        return;
      }

      try {
        await proxyUpgradeOverStream({
          stream,
          req,
          socket,
          head,
          ...(proxyOptions?.stripPathPrefix !== undefined
            ? { stripPathPrefix: proxyOptions.stripPathPrefix }
            : {}),
        });
      } catch (error) {
        stream.abort(error instanceof Error ? error : new Error(String(error)));
        writeUpgradeErrorResponse(socket, 502, "Bad Gateway");
      }
    },
    stop: async () => {
      registrations.clear();
      await node.stop();
    },
  };
}
