// @effect-diagnostics-next-line nodeBuiltinImport:off -- Node HTTP types for libp2p tunnel proxy.
import type * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Node stream types for libp2p tunnel proxy.
import type * as NodeStream from "node:stream";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import {
  createRelayLibp2pNode,
  type HttpProxyOptions,
  type RelayLibp2pNode,
  type RelayRegisteredEndpoint,
} from "@covecode/libp2p-tunnel";
import { makeReplicaDirectory, type ReplicaRoute } from "./ReplicaDirectory.ts";
import { RelayDb } from "../db.ts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schedule from "effect/Schedule";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import {
  DEFAULT_MANAGED_ENDPOINT_NAMESPACE,
  managedEndpointTunnelNameForKey,
} from "../deploymentConfig.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";

export function deriveTunnelConnectorToken(
  secret: string,
  input: {
    readonly endpointKey: string;
    readonly tunnelId: string;
    readonly environmentId: string;
  },
): string {
  const message = `${input.endpointKey}:${input.tunnelId}:${input.environmentId}`;
  const signature = hmac(
    sha256,
    new TextEncoder().encode(secret),
    new TextEncoder().encode(message),
  );
  return Base64Url.encode(signature);
}

function constantTimeEqualStrings(a: string, b: string): boolean {
  const bytesA = new TextEncoder().encode(a);
  const bytesB = new TextEncoder().encode(b);
  let diff = bytesA.length ^ bytesB.length;
  const len = Math.max(bytesA.length, bytesB.length);
  for (let i = 0; i < len; i += 1) {
    diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
  }
  return diff === 0;
}

export function verifyTunnelConnectorToken(
  secret: string,
  input: {
    readonly endpointKey: string;
    readonly tunnelId: string;
    readonly environmentId: string;
    readonly connectorToken: string;
  },
): boolean {
  const expected = deriveTunnelConnectorToken(secret, input);
  return constantTimeEqualStrings(expected, input.connectorToken);
}

export interface Libp2pTunnelRegistryService {
  readonly routes?: (keys: readonly string[]) => Effect.Effect<readonly ReplicaRoute[]>;
  readonly enabled: boolean;
  readonly peerId: string | null;
  readonly getMultiaddrs: () => ReadonlyArray<string>;
  readonly getEndpointRegistration: (endpointKey: string) => RelayRegisteredEndpoint | null;
  readonly isEndpointConnected: (endpointKey: string) => boolean;
  readonly proxyHttpRequest: (
    endpointKey: string,
    req: NodeHttp.IncomingMessage,
    res: NodeHttp.ServerResponse,
    options?: HttpProxyOptions,
  ) => Promise<void>;
  readonly proxyUpgrade: (
    endpointKey: string,
    req: NodeHttp.IncomingMessage,
    socket: NodeStream.Duplex,
    head: Buffer,
    options?: { readonly stripPathPrefix?: string },
  ) => Promise<void>;
}

export class Libp2pTunnelRegistry extends Context.Service<
  Libp2pTunnelRegistry,
  Libp2pTunnelRegistryService
>()("cove-cp/environments/Libp2pTunnelRegistry") {}

const makeDisabledService = (): Libp2pTunnelRegistryService => ({
  enabled: false,
  peerId: null,
  getMultiaddrs: () => [],
  getEndpointRegistration: () => null,
  isEndpointConnected: () => false,
  proxyHttpRequest: async (_endpointKey, _req, res) => {
    if (!res.headersSent && !res.writableEnded) {
      res.statusCode = 502;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "tunnel_unavailable", reason: "libp2p_disabled" }));
    }
  },
  proxyUpgrade: async (_endpointKey, _req, socket) => {
    if (!socket.destroyed && socket.writable) {
      socket.write(
        "HTTP/1.1 502 Tunnel Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      socket.destroy();
    }
  },
});

export function advertisedRelayMultiaddrs(
  configured: readonly string[],
  registry?: Libp2pTunnelRegistry["Service"],
) {
  const addresses = configured.length ? configured : (registry?.getMultiaddrs() ?? []);
  return addresses.map((address) => {
    const base = address.replace(/\/+$/u, "");
    return registry?.peerId && !base.includes("/p2p/") ? `${base}/p2p/${registry.peerId}` : base;
  });
}

export function routeForEndpoint(matching: readonly ReplicaRoute[]) {
  const registration = matching[0]?.registration;
  if (!registration) return undefined;
  return {
    libp2pPeerId: registration.peerId,
    libp2pDirectMultiaddrs: registration.directMultiaddrs,
    libp2pRelayMultiaddrs: [
      ...new Set(
        matching
          .filter((r) => r.registration.peerId === registration.peerId)
          .flatMap((r) => r.addresses),
      ),
    ],
  };
}

export const layerDisabled: Layer.Layer<Libp2pTunnelRegistry> = Layer.succeed(
  Libp2pTunnelRegistry,
  Libp2pTunnelRegistry.of(makeDisabledService()),
);

export const layerLive = Layer.effect(
  Libp2pTunnelRegistry,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
    const links = yield* EnvironmentLinks.EnvironmentLinks;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

    if (!config.libp2p.enabled) {
      return Libp2pTunnelRegistry.of(makeDisabledService());
    }

    const namespace = config.managedEndpointNamespace ?? DEFAULT_MANAGED_ENDPOINT_NAMESPACE;
    const tunnelSecret = Redacted.value(config.libp2p.tunnelSecret);

    const db = yield* RelayDb;
    const directory = config.libp2p.replicaMultiaddrs
      ? makeReplicaDirectory(
          db,
          yield* (yield* SecureRandom.SecureRandom).uuidV4().pipe(Effect.orDie),
        )
      : undefined;
    const node: RelayLibp2pNode = yield* Effect.acquireRelease(
      Effect.promise(() =>
        createRelayLibp2pNode({
          ...(config.libp2p.replicaMultiaddrs
            ? { replicaMultiaddrs: config.libp2p.replicaMultiaddrs }
            : {}),
          listenMultiaddrs: config.libp2p.listenMultiaddrs,
          announceMultiaddrs: config.libp2p.announceMultiaddrs,
          ...(config.libp2p.connectionLimits !== undefined
            ? { connectionLimits: config.libp2p.connectionLimits }
            : {}),
          ...(config.libp2p.keyPath !== undefined ? { keyPath: config.libp2p.keyPath } : {}),
          ...(directory
            ? {
                onEndpointReady: (entry: RelayRegisteredEndpoint) =>
                  runPromise(directory.record(entry.endpointKey, entry)),
                onEndpointDisconnected: (key: string) => {
                  void runPromise(
                    directory.record(key, null).pipe(Effect.catchCause(Effect.logWarning)),
                  );
                },
                remoteRoutes: async (key: string) => {
                  const routes = await runPromise(directory.routes([key]));
                  const peerId = routes[0]?.registration.peerId;
                  return routes
                    .filter((route) => route.registration.peerId === peerId)
                    .map((route) => ({
                      peerId: route.registration.peerId,
                      addresses: route.addresses.filter((a) => !a.endsWith(`/p2p/${node.peerId}`)),
                    }));
                },
              }
            : {}),
          validateRegistration: async ({ endpointId, endpointKey, connectorToken }) =>
            runPromise(
              Effect.gen(function* () {
                const allocation = yield* allocations.getByTunnelName(
                  managedEndpointTunnelNameForKey(namespace, endpointKey),
                );
                if (
                  allocation === null ||
                  allocation.tunnelReleasedAt !== null ||
                  allocation.tunnelId !== endpointId
                ) {
                  return false;
                }
                const activeLinks = yield* links.findActiveManagedForEnvironment({
                  environmentId: allocation.environmentId,
                  userId: allocation.userId,
                });
                if (activeLinks.length === 0) {
                  return false;
                }
                return verifyTunnelConnectorToken(tunnelSecret, {
                  endpointKey,
                  tunnelId: allocation.tunnelId,
                  environmentId: allocation.environmentId,
                  connectorToken,
                });
              }).pipe(
                Effect.tapError((error) =>
                  Effect.logWarning("Failed to validate libp2p tunnel registration", {
                    endpointId,
                    endpointKey,
                    error,
                  }),
                ),
              ),
            ),
        }),
      ),
      (relayNode) => Effect.promise(() => relayNode.stop()).pipe(Effect.ignore),
    );

    if (directory) {
      yield* Effect.acquireRelease(
        directory.start(node.peerId, node.getMultiaddrs()).pipe(Effect.orDie),
        () => directory.stop.pipe(Effect.ignore),
      );
      yield* directory
        .heartbeat()
        .pipe(
          Effect.catchCause(Effect.logWarning),
          Effect.repeat(Schedule.spaced("10 seconds")),
          Effect.forkScoped,
        );
    }
    return Libp2pTunnelRegistry.of({
      ...(directory
        ? { routes: (keys: readonly string[]) => directory.routes(keys).pipe(Effect.orDie) }
        : {}),
      enabled: true,
      peerId: node.peerId,
      getMultiaddrs: () => node.getMultiaddrs(),
      getEndpointRegistration: (endpointKey) => node.getEndpointRegistration(endpointKey),
      isEndpointConnected: (endpointKey) => node.isEndpointConnected(endpointKey),
      proxyHttpRequest: (endpointKey, req, res, options) =>
        node.proxyHttpRequest(endpointKey, req, res, options),
      proxyUpgrade: (endpointKey, req, socket, head, options) =>
        node.proxyUpgrade(endpointKey, req, socket, head, options),
    });
  }),
);
