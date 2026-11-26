import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer, type CircuitRelayService } from "@libp2p/circuit-relay-v2";
import { identify, identifyPush } from "@libp2p/identify";
import type { Libp2p, PeerId, PrivateKey, Stream } from "@libp2p/interface";
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
  readonly announceMultiaddrs?: readonly string[];
  readonly keyPath?: string;
  readonly privateKey?: PrivateKey;
  readonly maxReservations?: number;
  readonly validateRegistration: (
    input: RelayRegistrationValidationInput,
  ) => Promise<boolean> | boolean;
  readonly onEndpointRegistered?: (registration: RelayRegisteredEndpoint) => void;
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
  readonly endpointKey: string;
  readonly endpointId: string;
  readonly peerId: PeerId;
  readonly connectedAt: number;
  readonly directMultiaddrs: readonly string[];
}

interface RegisterMessagePayload {
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
  const announce =
    options.announceMultiaddrs && options.announceMultiaddrs.length > 0
      ? [...options.announceMultiaddrs]
      : undefined;

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
    transports: [webSockets(), tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      identifyPush: identifyPush(),
      circuitRelay: circuitRelayServer({
        reservations: {
          maxReservations: options.maxReservations ?? 1000,
          applyDefaultLimit: false,
        },
      }),
    },
  });

  const registrations = new Map<string, InternalRegistrationRecord>();

  node.addEventListener("peer:disconnect", (evt) => {
    const disconnectedPeer = evt.detail;
    const stillOpen = node.getConnections(disconnectedPeer).some((conn) => conn.status === "open");
    if (stillOpen) return;
    for (const [key, entry] of registrations.entries()) {
      if (entry.peerId.equals(disconnectedPeer)) {
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

        const record: InternalRegistrationRecord = {
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
        registrations.set(endpointKey, record);
        options.onEndpointRegistered?.({
          endpointKey: record.endpointKey,
          endpointId: record.endpointId,
          peerId: record.peerId.toString(),
          connectedAt: record.connectedAt,
          directMultiaddrs: record.directMultiaddrs,
        });
        await writeJsonLine(stream, { ok: true });
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
    const entry = registrations.get(endpointKey);
    if (!entry) {
      throw new Error(`No tunnel endpoint registered for key "${endpointKey}"`);
    }
    const connection = node.getConnections(entry.peerId).find((conn) => conn.status === "open");
    if (!connection) {
      registrations.delete(endpointKey);
      options.onEndpointDisconnected?.(endpointKey);
      throw new Error(`Tunnel endpoint "${endpointKey}" has no open connection`);
    }
    return connection.newStream(COVE_TUNNEL_PROTOCOL, {
      runOnLimitedConnection: true,
      ...(openOptions?.signal !== undefined ? { signal: openOptions.signal } : {}),
    });
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
      return node.getConnections(entry.peerId).some((conn) => conn.status === "open");
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
