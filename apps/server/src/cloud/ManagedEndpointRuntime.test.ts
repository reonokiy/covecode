import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import {
  type EnvironmentLibp2pTunnel,
  type EnvironmentLibp2pTunnelOptions,
  TunnelRegistrationUnauthorizedError,
} from "@t3tools/libp2p-tunnel";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { RELAY_URL_SECRET } from "./config.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

interface FakeTunnelController {
  readonly options: EnvironmentLibp2pTunnelOptions;
  readonly stopped: () => boolean;
}

const sampleConfig: RelayManagedEndpointRuntimeConfig = {
  providerKind: "libp2p_tunnel",
  connectorToken: "connector-token-1",
  tunnelId: "libp2p-0123456789abcdef",
  tunnelName: "cove-managedendpoint-0123456789abcdef",
  endpointKey: "0123456789abcdef",
  publicHttpBaseUrl: "https://relay.example.test/t/0123456789abcdef/",
  relayMultiaddrs: ["/dns4/relay.example.test/tcp/4002/wss/p2p/12D3KooWRelayPeer"],
  transportMode: "p2p",
};

const unusedHttpClient = HttpClient.make(() => Effect.die("unused"));

const encode = (value: string) => new TextEncoder().encode(value);

const defaultSecretStoreLayer = Layer.mock(ServerSecretStore.ServerSecretStore)({
  get: (name) =>
    name === RELAY_URL_SECRET
      ? Effect.succeedSome(encode("https://relay.example.test"))
      : Effect.succeedNone,
  set: () => Effect.void,
});

function buildRuntime(options: {
  readonly createTunnel: ManagedEndpointRuntime.CreateEnvironmentLibp2pTunnelFn;
  readonly httpClient?: HttpClient.HttpClient;
  readonly secretStoreLayer?: Layer.Layer<ServerSecretStore.ServerSecretStore>;
  readonly env?: Record<string, string>;
  readonly policy?: Parameters<typeof ManagedPolicy.layerTest>[0];
}) {
  const deps = Layer.mergeAll(
    ManagedPolicy.layerTest(options.policy),
    Layer.succeed(HttpClient.HttpClient, options.httpClient ?? unusedHttpClient),
    options.secretStoreLayer ?? defaultSecretStoreLayer,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-managed-endpoint-" }),
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

  return ManagedEndpointRuntime.layerWithFactory(options.createTunnel).pipe(
    Layer.provide(deps),
    (layer) =>
      Effect.gen(function* () {
        const context = yield* Layer.build(layer);
        return yield* Effect.service(ManagedEndpointRuntime.CloudManagedEndpointRuntime).pipe(
          Effect.provide(context),
        );
      }).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.env ?? {} }))),
      ),
  );
}

describe("CloudManagedEndpointRuntime (libp2p)", () => {
  it.effect("serializes updates to persisted cloud link state", () =>
    Effect.gen(function* () {
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();
      const runtime = yield* buildRuntime({
        createTunnel: async () => {
          throw new Error("unused");
        },
      });

      const first = yield* runtime
        .withLinkStateLock(
          Deferred.succeed(firstEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstEntered);

      const second = yield* runtime
        .withLinkStateLock(Deferred.succeed(secondEntered, undefined))
        .pipe(Effect.forkChild);
      expect(yield* Deferred.isDone(secondEntered)).toBe(false);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(yield* Deferred.isDone(secondEntered)).toBe(true);
    }),
  );

  it.effect(
    "starts an in-process libp2p tunnel, reports connector facts, and emits connection streams",
    () =>
      Effect.gen(function* () {
        const created: Array<FakeTunnelController> = [];
        const runtime = yield* buildRuntime({
          createTunnel: async (opts) => {
            let isStopped = false;
            created.push({ options: opts, stopped: () => isStopped });
            opts.onStatusChange?.({
              state: "connecting",
              peerId: "12D3KooWEnvPeer",
              circuitMultiaddrs: [],
            });
            opts.onStatusChange?.({
              state: "connected",
              peerId: "12D3KooWEnvPeer",
              circuitMultiaddrs: ["/p2p/12D3KooWRelayPeer/p2p-circuit"],
            });
            return {
              peerId: "12D3KooWEnvPeer",
              getCircuitMultiaddrs: () => ["/p2p/12D3KooWRelayPeer/p2p-circuit"],
              isConnected: () => !isStopped,
              waitForRelayReservation: async () => [],
              stop: async () => {
                isStopped = true;
              },
            } satisfies EnvironmentLibp2pTunnel;
          },
        });

        yield* runtime.setLocalOrigin({ localHttpHost: "127.0.0.1", localHttpPort: 4123 });
        const connectedEvent = yield* runtime.tunnelConnected.pipe(
          Stream.take(1),
          Stream.runHead,
          Effect.forkChild,
        );
        const readinessEvent = yield* runtime.readinessChanged.pipe(
          Stream.take(1),
          Stream.runHead,
          Effect.forkChild,
        );

        const status = yield* runtime.applyConfig(sampleConfig);
        expect(status).toEqual({
          status: "running",
          providerKind: "libp2p_tunnel",
          pid: 1,
          peerId: "12D3KooWEnvPeer",
          tunnelId: "libp2p-0123456789abcdef",
          tunnelName: "cove-managedendpoint-0123456789abcdef",
        });

        expect(Option.isSome(yield* Fiber.join(connectedEvent))).toBe(true);
        expect(Option.isSome(yield* Fiber.join(readinessEvent))).toBe(true);
        expect(created).toHaveLength(1);
        expect(created[0]?.options.localHost).toBe("127.0.0.1");
        expect(created[0]?.options.localPort).toBe(4123);
        expect(created[0]?.options.enableP2p).toBe(true);

        const facts = yield* runtime.inspectConnector;
        expect(facts).toEqual({
          pid: 1,
          readyConnections: 1,
          hostname: "relay.example.test",
          origin: "http://127.0.0.1:4123",
          protocol: "libp2p",
          publicHttpBaseUrl: "https://relay.example.test/t/0123456789abcdef/",
          peerId: "12D3KooWEnvPeer",
        });

        // Reapplying identical config does not restart the tunnel.
        const reapplied = yield* runtime.applyConfig(sampleConfig);
        expect(reapplied).toEqual(status);
        expect(created).toHaveLength(1);

        // Passing null stops the tunnel.
        const disabled = yield* runtime.applyConfig(null);
        expect(disabled).toEqual({ status: "disabled" });
        expect(created[0]?.stopped()).toBe(true);
        expect(yield* runtime.inspectConnector).toBeNull();
      }),
  );

  it.effect("discovers libp2p relay multiaddrs from control plane when omitted in config", () =>
    Effect.gen(function* () {
      const seenMultiaddrs: Array<readonly string[]> = [];
      const runtime = yield* buildRuntime({
        httpClient: HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                controlPlaneUrl: "https://relay.example.test",
                oidc: null,
                libp2p: {
                  enabled: true,
                  peerId: "12D3KooWRelayPeer",
                  relayMultiaddrs: ["/dns4/relay.example.test/tcp/4002/wss/p2p/12D3KooWRelayPeer"],
                },
              }),
            ),
          ),
        ),
        createTunnel: async (opts) => {
          seenMultiaddrs.push(opts.relayMultiaddrs);
          return {
            peerId: "12D3KooWEnvPeer",
            getCircuitMultiaddrs: () => [],
            isConnected: () => true,
            waitForRelayReservation: async () => [],
            stop: async () => {},
          };
        },
      });

      const { relayMultiaddrs: _omitted, ...configWithoutMultiaddrs } = sampleConfig;
      const status = yield* runtime.applyConfig(configWithoutMultiaddrs);
      expect(status.status).toBe("running");
      expect(seenMultiaddrs).toEqual([
        ["/dns4/relay.example.test/tcp/4002/wss/p2p/12D3KooWRelayPeer"],
      ]);
    }),
  );

  it.effect("requests recovery when tunnel registration fails authorization", () =>
    Effect.gen(function* () {
      const runtime = yield* buildRuntime({
        createTunnel: async () => {
          throw new TunnelRegistrationUnauthorizedError("Relay rejected tunnel registration");
        },
      });
      const recovery = yield* runtime.recoveryRequests.pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.forkChild,
      );

      const status = yield* runtime.applyConfig(sampleConfig);
      expect(status).toMatchObject({
        status: "failed",
        providerKind: "libp2p_tunnel",
        failure: "spawn-failed",
      });
      expect(Option.getOrNull(yield* Fiber.join(recovery))).toEqual(sampleConfig);
    }),
  );

  it.effect("restarts the connector only when pid matches and stillDead returns true", () =>
    Effect.gen(function* () {
      let stops = 0;
      let starts = 0;
      const runtime = yield* buildRuntime({
        createTunnel: async (opts) => {
          starts += 1;
          opts.onStatusChange?.({
            state: "connected",
            peerId: `peer-${starts}`,
            circuitMultiaddrs: [],
          });
          return {
            peerId: `peer-${starts}`,
            getCircuitMultiaddrs: () => [],
            isConnected: () => true,
            waitForRelayReservation: async () => [],
            stop: async () => {
              stops += 1;
            },
          };
        },
      });

      yield* runtime.applyConfig(sampleConfig);
      expect(yield* runtime.restartConnector(999, Effect.succeed(true))).toBe(false);
      expect(yield* runtime.restartConnector(1, Effect.succeed(false))).toBe(false);
      expect(stops).toBe(0);

      expect(yield* runtime.restartConnector(1, Effect.succeed(true))).toBe(true);
      expect(stops).toBe(1);
      expect(starts).toBe(2);
      expect((yield* runtime.inspectConnector)?.pid).toBe(2);
    }),
  );

  it.effect("returns unsupported for non-libp2p providers and disables when policy refuses", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<string>();
      const runtime = yield* buildRuntime({
        createTunnel: async () => {
          Queue.offerUnsafe(events, "started");
          return {
            peerId: "peer",
            getCircuitMultiaddrs: () => [],
            isConnected: () => true,
            waitForRelayReservation: async () => [],
            stop: async () => {},
          };
        },
      });

      const unsupported = yield* runtime.applyConfig({
        providerKind: "manual",
        connectorToken: "token",
      });
      expect(unsupported).toEqual({ status: "unsupported", providerKind: "manual" });
      expect(yield* Queue.size(events)).toBe(0);

      const refusedRuntime = yield* buildRuntime({
        policy: { schemaVersion: 1, organization: "Acme", limits: { connect: false } },
        createTunnel: async () => {
          throw new Error("should not start");
        },
      });
      expect(yield* refusedRuntime.applyConfig(sampleConfig)).toEqual({ status: "disabled" });
    }),
  );
});
