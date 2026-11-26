import * as NodeNet from "node:net";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import {
  circuitRelayTransport,
  type CircuitRelayTransportComponents,
} from "@libp2p/circuit-relay-v2";
import { dcutr } from "@libp2p/dcutr";
import { identify, identifyPush } from "@libp2p/identify";
import multicastDns from "multicast-dns";
import { isPrivate } from "@libp2p/utils";
import type { Libp2p, Connection, Listener, PrivateKey } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { webRTC, webRTCDirect } from "@libp2p/webrtc";
import { BROWSER_TUNNEL_PROTOCOL } from "./browserProtocol.ts";
import { serveBrowserStream } from "./browserBridge.ts";
import { webSockets } from "@libp2p/websockets";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";
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
  readonly readyConnections?: number;
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
  readonly confirmReservation?: boolean;
  readonly ok?: unknown;
  readonly error?: unknown;
}

export class TunnelRegistrationUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TunnelRegistrationUnauthorizedError";
  }
}

async function handleEnvironmentStreams(node: Libp2p, localHost: string, localPort: number) {
  await node.handle(
    COVE_TUNNEL_PROTOCOL,
    (stream) => {
      const targetSocket = NodeNet.connect({
        host: localHost,
        port: localPort,
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
    (stream) => serveBrowserStream(stream, localHost, localPort),
    {
      runOnLimitedConnection: true,
      maxInboundStreams: 256,
      maxOutboundStreams: 256,
    },
  );
}

export async function createLanEnvironmentTunnel(options: {
  readonly bindHost: string;
  readonly localPort: number;
  readonly keyPath: string;
}) {
  const listenHost = options.bindHost === "::" ? "0.0.0.0" : options.bindHost;
  const privateKey = await loadOrCreateLibp2pPrivateKey(options.keyPath);
  const node = await createLibp2p({
    privateKey,
    addresses: {
      listen: [`/ip4/${listenHost}/tcp/0`, `/ip4/${listenHost}/udp/0/webrtc-direct`],
      announceFilter: (addresses) =>
        addresses.filter(
          (addr) =>
            isPrivate(addr) &&
            (options.bindHost.startsWith("127.") || !addr.toString().startsWith("/ip4/127.")),
        ),
    },
    connectionGater: {
      denyInboundConnection: (conn) => !isPrivate(conn.remoteAddr),
      denyDialPeer: () => true,
    },
    transports: [tcp(), webRTCDirect()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
  try {
    await handleEnvironmentStreams(
      node,
      options.bindHost === "::" ? "::1" : listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost,
      options.localPort,
    );
  } catch (error) {
    await node.stop();
    throw error;
  }
  const peerId = node.peerId.toString();
  const getPeer = () => ({ peerId, direct: node.getMultiaddrs().map(String) });
  const service = "_p2p._udp.local";
  const instance = peerId + "." + service;
  const dns = multicastDns(
    listenHost === "0.0.0.0" ? {} : { interface: listenHost, bind: "0.0.0.0" },
  );
  dns.on("error", (error) =>
    node.logger.forComponent("cove:lan").error("LAN discovery error: %e", error),
  );
  dns.on("query", ({ questions = [] }) => {
    const browse = questions.some((q) => q.type === "PTR" && q.name.toLowerCase() === service);
    const lookup = questions.some(
      (q) => q.type === "TXT" && q.name.toLowerCase() === instance.toLowerCase(),
    );
    if (!browse && !lookup) return;
    const data = getPeer()
      .direct.slice(0, 16)
      .map((address) => "dnsaddr=" + address);
    if (!data.length) return;
    const txt = { type: "TXT" as const, name: instance, ttl: 10, data };
    // libp2p browsers read the additional TXT record. Apple Bonjour can query it by name.
    dns.respond(
      lookup
        ? { answers: [txt] }
        : {
            answers: [{ type: "PTR", name: service, ttl: 10, data: instance }],
            additionals: [txt],
          },
    );
  });
  return {
    getPeer,
    async stop() {
      await new Promise<void>((resolve) => dns.destroy(resolve));
      await node.stop();
    },
  };
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

  const groups = new Map<string, string[]>();
  for (const raw of options.relayMultiaddrs) {
    // Legacy addresses without a peer ID are alternative transports for one relay.
    const key = /\/p2p\/([^/]+)\/?$/u.exec(raw)?.[1] ?? "";
    const group = groups.get(key) ?? [];
    group.push(raw);
    groups.set(key, group);
  }

  const enableP2p = options.enableP2p !== false;
  const privateKey = options.privateKey ?? (await loadOrCreateLibp2pPrivateKey(options.keyPath));

  const node = await createLibp2p({
    privateKey,
    addresses: {
      listen: enableP2p ? ["/ip4/0.0.0.0/tcp/0", "/webrtc"] : [],
    },
    transports: [
      webSockets(),
      ...(enableP2p ? [webRTC()] : []),
      tcp(),
      circuitRelayTransport({ reservationCompletionTimeout: 10_000 }),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      identifyPush: identifyPush(),
      relayReservation: ({
        transportManager,
      }: Pick<CircuitRelayTransportComponents, "transportManager">) => {
        const listeners = new Map<string, Listener>();
        let pending = Promise.resolve();
        async function open(peer: string, address: Multiaddr) {
          const listener = listeners.get(peer);
          if (listener) return listener.listen(address);
          const existing = new Set(transportManager.getListeners());
          const opening = transportManager.listen([address]);
          // libp2p installs the listener synchronously before awaiting its reservation.
          const added = transportManager.getListeners().find((entry) => !existing.has(entry));
          if (added) listeners.set(peer, added);
          await opening;
        }
        return {
          listen(peer: string, address: Multiaddr) {
            // The reservation store clears queued requests after each configured reservation.
            const opening = pending.then(() => open(peer, address));
            pending = opening.catch(() => {});
            return opening;
          },
        };
      },
      ...(enableP2p ? { dcutr: dcutr() } : {}),
    },
  });

  let stopped = false;
  const activePeers = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const getCircuitMultiaddrs = (): string[] =>
    node
      .getMultiaddrs()
      .map((ma) => ma.toString())
      .filter((addr) => addr.includes("/p2p-circuit"));

  const emitStatus = (state: EnvironmentTunnelState, error?: string) => {
    options.onStatusChange?.({
      state,
      readyConnections: activePeers.size,
      peerId: node.peerId.toString(),
      circuitMultiaddrs: getCircuitMultiaddrs(),
      ...(error !== undefined ? { error } : {}),
    });
  };

  await handleEnvironmentStreams(node, options.localHost, options.localPort);

  const dialAndRegister = async (addresses: readonly string[]): Promise<Connection> => {
    let lastError: unknown;
    let selectedConnection: Connection | null = null;
    let selectedAddress: Multiaddr | undefined;

    for (const rawAddr of addresses) {
      if (stopped) throw new Error("Tunnel stopped");
      try {
        const address = multiaddr(rawAddr);
        selectedConnection = await node.dial(address);
        selectedAddress = address;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!selectedConnection || !selectedAddress) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`Failed to dial any relay multiaddr (${addresses.join(", ")})`);
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

    const relayAddress = selectedAddress
      .toString()
      .endsWith(`/p2p/${selectedConnection.remotePeer}`)
      ? selectedAddress
      : selectedAddress.encapsulate(`/p2p/${selectedConnection.remotePeer}`);
    const peer = selectedConnection.remotePeer.toString();
    await node.services.relayReservation.listen(peer, relayAddress.encapsulate("/p2p-circuit"));
    if (ack.confirmReservation) {
      const ready = await selectedConnection.newStream(COVE_TUNNEL_REGISTER_PROTOCOL);
      await writeJsonLine(ready, { ready: true, endpointKey: options.endpointKey });
      const result = await readBoundedJsonLine<RegisterResponsePayload>(ready);
      if (!result.ok) throw new Error("Relay reservation no longer active");
    }
    if (stopped) throw new Error("Tunnel stopped");
    if (selectedConnection.status !== "open")
      throw new Error("Relay disconnected during registration");
    return selectedConnection;
  };

  let started = false;
  const initialFailures: Array<() => void> = [];
  const rejected = new Set<readonly string[]>();
  function maintainRelay(addresses: readonly string[]) {
    let connection: Connection | undefined;
    let failures = 0;
    let pending = false;
    function schedule(error?: string) {
      if (stopped || pending) return;
      pending = true;
      if (activePeers.size === 0) emitStatus("reconnecting", error);
      const delay = Math.min(
        options.reconnectMaxDelayMs ?? 30_000,
        (options.reconnectBaseDelayMs ?? 500) * 2 ** failures++,
      );
      const timer = setTimeout(() => {
        timers.delete(timer);
        pending = false;
        void connect().catch(() => {});
      }, delay);
      timers.add(timer);
    }
    async function connect() {
      try {
        connection = await dialAndRegister(addresses);
        activePeers.add(connection.id);
        emitStatus("connected");
        failures = 0;
      } catch (error) {
        if (!(error instanceof TunnelRegistrationUnauthorizedError)) {
          const reason = error instanceof Error ? error.message : String(error);
          if (started) schedule(reason);
          else initialFailures.push(() => schedule(reason));
        } else {
          rejected.add(addresses);
          if (!stopped && rejected.size === groups.size) emitStatus("stopped", error.message);
        }
        throw error;
      }
    }
    node.addEventListener("connection:close", ({ detail }) => {
      if (detail.id !== connection?.id) return;
      activePeers.delete(detail.id);
      connection = undefined;
      if (!stopped && activePeers.size > 0) emitStatus("connected");
      schedule();
    });
    return connect();
  }
  const stop = async () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    activePeers.clear();
    await node.stop();
  };
  emitStatus("connecting");
  try {
    await Promise.any(Array.from(groups.values(), maintainRelay));
    started = true;
    for (const retry of initialFailures.splice(0)) retry();
  } catch (error) {
    await stop();
    if (error instanceof AggregateError) {
      throw (
        error.errors.find((cause) => !(cause instanceof TunnelRegistrationUnauthorizedError)) ??
        error.errors[0]
      );
    }
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
    isConnected: () => activePeers.size > 0,
    waitForRelayReservation,
    stop: async () => {
      await stop();
      emitStatus("stopped");
    },
  };
}
