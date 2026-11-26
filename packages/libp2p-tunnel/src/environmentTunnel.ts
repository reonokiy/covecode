import * as NodeNet from "node:net";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { dcutr } from "@libp2p/dcutr";
import { identify, identifyPush } from "@libp2p/identify";
import type { Connection, Libp2p, PeerId, PrivateKey } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { webRTC } from "@libp2p/webrtc";
import { BROWSER_TUNNEL_PROTOCOL } from "./browserProtocol.ts";
import { serveBrowserStream } from "./browserBridge.ts";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";

import {
  COVE_TUNNEL_PROTOCOL,
  COVE_TUNNEL_REGISTER_PROTOCOL,
  isAllowedLoopbackHost,
  loadOrCreateLibp2pPrivateKey,
  pipeStreamAndSocket,
  readBoundedJsonLine,
  writeJsonLine,
} from "./protocols.ts";

export type EnvironmentTunnelState = "connecting" | "connected" | "reconnecting" | "stopped";

export interface EnvironmentTunnelStatusEvent {
  readonly state: EnvironmentTunnelState;
  readonly peerId: string;
  readonly circuitMultiaddrs: readonly string[];
  readonly error?: string;
}

export interface EnvironmentLibp2pTunnelOptions {
  readonly relayMultiaddrs: readonly string[];
  readonly endpointId: string;
  readonly endpointKey: string;
  readonly connectorToken: string;
  readonly localHost: string;
  readonly localPort: number;
  readonly enableP2p?: boolean;
  readonly keyPath?: string;
  readonly privateKey?: PrivateKey;
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly onStatusChange?: (status: EnvironmentTunnelStatusEvent) => void;
}

export interface EnvironmentLibp2pTunnel {
  readonly peerId: string;
  getCircuitMultiaddrs: () => string[];
  isConnected: () => boolean;
  waitForRelayReservation: (timeoutMs?: number) => Promise<string[]>;
  stop: () => Promise<void>;
}

interface RegisterResponsePayload {
  readonly ok?: unknown;
  readonly error?: unknown;
}

export class TunnelRegistrationUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TunnelRegistrationUnauthorizedError";
  }
}

export async function createEnvironmentLibp2pTunnel(
  options: EnvironmentLibp2pTunnelOptions,
): Promise<EnvironmentLibp2pTunnel> {
  if (!isAllowedLoopbackHost(options.localHost)) {
    throw new Error(
      `Refusing to forward libp2p tunnel to non-loopback host "${options.localHost}"`,
    );
  }
  if (options.relayMultiaddrs.length === 0) {
    throw new Error("At least one relay multiaddr is required to start the libp2p tunnel");
  }

  const enableP2p = options.enableP2p !== false;
  const privateKey = options.privateKey ?? (await loadOrCreateLibp2pPrivateKey(options.keyPath));

  const node: Libp2p = await createLibp2p({
    privateKey,
    addresses: {
      listen: [...(enableP2p ? ["/ip4/0.0.0.0/tcp/0", "/webrtc"] : []), "/p2p-circuit"],
    },
    transports: [
      webSockets(),
      ...(enableP2p ? [webRTC()] : []),
      tcp(),
      circuitRelayTransport({
        reservationCompletionTimeout: 10_000,
        discoveryFilter: {
          has: () => false,
          add: () => {},
          remove: () => {},
        },
      }),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      identifyPush: identifyPush(),
      ...(enableP2p ? { dcutr: dcutr() } : {}),
    },
  });

  let stopped = false;
  let activeRelayPeer: PeerId | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectAttemptInFlight: Promise<void> | null = null;
  let consecutiveFailures = 0;

  const getCircuitMultiaddrs = (): string[] =>
    node
      .getMultiaddrs()
      .map((ma) => ma.toString())
      .filter((addr) => addr.includes("/p2p-circuit"));

  const emitStatus = (state: EnvironmentTunnelState, error?: string) => {
    options.onStatusChange?.({
      state,
      peerId: node.peerId.toString(),
      circuitMultiaddrs: getCircuitMultiaddrs(),
      ...(error !== undefined ? { error } : {}),
    });
  };

  await node.handle(
    COVE_TUNNEL_PROTOCOL,
    (stream) => {
      const targetSocket = NodeNet.connect({
        host: options.localHost,
        port: options.localPort,
      });
      pipeStreamAndSocket(stream, targetSocket);
    },
    {
      runOnLimitedConnection: true,
      maxInboundStreams: 256,
      maxOutboundStreams: 256,
    },
  );

  await node.handle(
    BROWSER_TUNNEL_PROTOCOL,
    (stream) => serveBrowserStream(stream, options.localHost, options.localPort),
    {
      runOnLimitedConnection: true,
      maxInboundStreams: 256,
      maxOutboundStreams: 256,
    },
  );

  const dialAndRegister = async (): Promise<void> => {
    let lastError: unknown;
    let selectedConnection: Connection | null = null;

    for (const rawAddr of options.relayMultiaddrs) {
      if (stopped) return;
      try {
        selectedConnection = await node.dial(multiaddr(rawAddr));
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!selectedConnection) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`Failed to dial any relay multiaddr (${options.relayMultiaddrs.join(", ")})`);
    }

    const regStream = await selectedConnection.newStream(COVE_TUNNEL_REGISTER_PROTOCOL, {
      runOnLimitedConnection: true,
    });
    await writeJsonLine(regStream, {
      endpointId: options.endpointId,
      endpointKey: options.endpointKey,
      connectorToken: options.connectorToken,
      directMultiaddrs: enableP2p
        ? node
            .getMultiaddrs()
            .map(String)
            .filter((address) => !address.includes("/p2p-circuit"))
            .slice(0, 16)
        : [],
    });
    const ack = await readBoundedJsonLine<RegisterResponsePayload>(regStream);
    if (ack.ok !== true) {
      const reason = typeof ack.error === "string" ? ack.error : "registration_rejected";
      await selectedConnection.close().catch(() => {});
      throw new TunnelRegistrationUnauthorizedError(
        `Relay rejected tunnel registration: ${reason}`,
      );
    }

    activeRelayPeer = selectedConnection.remotePeer;
    consecutiveFailures = 0;
    emitStatus("connected");
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== undefined || connectAttemptInFlight !== null) {
      return;
    }
    const baseDelay = options.reconnectBaseDelayMs ?? 500;
    const maxDelay = options.reconnectMaxDelayMs ?? 30_000;
    const delay = Math.min(maxDelay, baseDelay * Math.pow(2, consecutiveFailures));
    consecutiveFailures += 1;
    emitStatus("reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (stopped) return;
      connectAttemptInFlight = dialAndRegister()
        .catch((error) => {
          if (error instanceof TunnelRegistrationUnauthorizedError) {
            emitStatus("stopped", error.message);
            return;
          }
          emitStatus("reconnecting", error instanceof Error ? error.message : String(error));
          scheduleReconnect();
        })
        .finally(() => {
          connectAttemptInFlight = null;
        });
    }, delay);
  };

  node.addEventListener("peer:disconnect", (evt) => {
    if (stopped || activeRelayPeer === null) return;
    if (!evt.detail.equals(activeRelayPeer)) return;
    const stillOpen = node.getConnections(activeRelayPeer).some((conn) => conn.status === "open");
    if (!stillOpen) {
      activeRelayPeer = null;
      scheduleReconnect();
    }
  });

  emitStatus("connecting");
  try {
    await dialAndRegister();
  } catch (error) {
    await Promise.resolve(node.stop()).catch(() => {});
    throw error;
  }

  const waitForRelayReservation = async (timeoutMs = 10_000): Promise<string[]> => {
    const existing = getCircuitMultiaddrs();
    if (existing.length > 0) {
      return existing;
    }

    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        node.removeEventListener("self:peer:update", onUpdate);
        reject(new Error(`Timed out waiting ${timeoutMs}ms for circuit relay reservation`));
      }, timeoutMs);

      const onUpdate = () => {
        const current = getCircuitMultiaddrs();
        if (current.length > 0) {
          clearTimeout(timer);
          node.removeEventListener("self:peer:update", onUpdate);
          resolve(current);
        }
      };

      node.addEventListener("self:peer:update", onUpdate);
      onUpdate();
    });
  };

  return {
    peerId: node.peerId.toString(),
    getCircuitMultiaddrs,
    isConnected: () =>
      activeRelayPeer !== null &&
      node.getConnections(activeRelayPeer).some((conn) => conn.status === "open"),
    waitForRelayReservation,
    stop: async () => {
      stopped = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      activeRelayPeer = null;
      emitStatus("stopped");
      await node.stop();
    },
  };
}
