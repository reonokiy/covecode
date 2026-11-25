import {
  RelayControlPlanePublicConfig,
  type RelayManagedEndpointOrigin,
  type RelayManagedEndpointRuntimeConfig,
} from "@t3tools/contracts/relay";
import {
  createEnvironmentLibp2pTunnel,
  type EnvironmentLibp2pTunnel,
  type EnvironmentLibp2pTunnelOptions,
  type EnvironmentTunnelStatusEvent,
  TunnelRegistrationUnauthorizedError,
} from "@covecode/libp2p-tunnel";
import { RotatingFileSink, RotatingFileSinkError } from "@t3tools/shared/logging";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import {
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  decodeConfirmedOrigin,
  RELAY_URL_SECRET,
} from "./config.ts";
import { relayUrlConfig } from "./publicConfig.ts";

export type CreateEnvironmentLibp2pTunnelFn = (
  options: EnvironmentLibp2pTunnelOptions,
) => Promise<EnvironmentLibp2pTunnel>;

export type CloudManagedEndpointRuntimeStatus =
  | {
      readonly status: "disabled";
    }
  | {
      readonly status: "failed";
      readonly providerKind: RelayManagedEndpointRuntimeConfig["providerKind"];
      readonly failure: "unsupported-platform" | "not-installed" | "spawn-failed";
      readonly reason: string;
      readonly tunnelId?: string;
      readonly tunnelName?: string;
    }
  | {
      readonly status: "running";
      readonly providerKind: "libp2p_tunnel";
      readonly pid: number;
      readonly tunnelId?: string;
      readonly tunnelName?: string;
      readonly peerId?: string;
    }
  | {
      readonly status: "unsupported";
      readonly providerKind: RelayManagedEndpointRuntimeConfig["providerKind"];
    };

/** Facts reported about the active in-process libp2p tunnel connector. `null` fields are not known yet. */
export interface ConnectorFacts {
  readonly pid: number;
  readonly readyConnections: number | null;
  readonly hostname: string | null;
  readonly origin: string | null;
  readonly protocol: string | null;
  readonly publicHttpBaseUrl?: string | null;
  readonly peerId?: string | null;
}

export class CloudManagedEndpointRuntime extends Context.Service<
  CloudManagedEndpointRuntime,
  {
    readonly applyConfig: (
      config: RelayManagedEndpointRuntimeConfig | null,
      options?: { readonly origin?: RelayManagedEndpointOrigin },
    ) => Effect.Effect<CloudManagedEndpointRuntimeStatus>;
    readonly setLocalOrigin: (origin: RelayManagedEndpointOrigin) => Effect.Effect<void>;
    /** `null` when no connector is running. */
    readonly inspectConnector: Effect.Effect<ConnectorFacts | null>;
    /** Emits when the connector registers a connection or its readiness changes. */
    readonly readinessChanged: Stream.Stream<void>;
    readonly recoveryRequests: Stream.Stream<RelayManagedEndpointRuntimeConfig>;
    readonly requestRecovery: (config: RelayManagedEndpointRuntimeConfig) => Effect.Effect<void>;
    /**
     * Restarts the connector if it still runs as `pid` and `stillDead` holds once it has
     * the lock. Returns whether it restarted the connector.
     */
    readonly restartConnector: (
      pid: number,
      stillDead: Effect.Effect<boolean>,
    ) => Effect.Effect<boolean>;
    readonly tunnelConnected: Stream.Stream<void>;
    readonly withLinkStateLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/cloud/ManagedEndpointRuntime/CloudManagedEndpointRuntime") {}

interface ActiveConnector {
  readonly pid: number;
  readonly tunnel: EnvironmentLibp2pTunnel;
  readonly scope: Scope.Closeable;
  readonly configKey: string;
  readonly config: RelayManagedEndpointRuntimeConfig;
  readonly originUrl: string;
  readonly publicHttpBaseUrl: string | null;
  readonly hostname: string | null;
  readonly getReadyConnections: () => number | null;
  readonly getPeerId: () => string | null;
  readonly markStopped: () => void;
}

const isRotatingFileSinkError = Schema.is(RotatingFileSinkError);
const CONTROL_PLANE_DISCOVERY_TIMEOUT = Duration.seconds(10);
export const RELAY_CLIENT_LOG_FILE = "relay-client.ndjson";

export function isRetryableManagedEndpointRuntimeStatus(status: unknown): boolean {
  if (typeof status !== "object" || status === null || !("status" in status)) {
    return false;
  }
  if (status.status !== "failed" || !("failure" in status)) {
    return false;
  }
  return status.failure === "not-installed" || status.failure === "spawn-failed";
}

function formatOriginUrl(origin: RelayManagedEndpointOrigin): string {
  const host =
    origin.localHttpHost.includes(":") && !origin.localHttpHost.startsWith("[")
      ? `[${origin.localHttpHost}]`
      : origin.localHttpHost;
  return `http://${host}:${origin.localHttpPort}`;
}

function runtimeConfigKey(
  config: RelayManagedEndpointRuntimeConfig,
  origin: RelayManagedEndpointOrigin,
): string {
  return JSON.stringify({
    providerKind: config.providerKind,
    connectorToken: config.connectorToken,
    tunnelId: config.tunnelId ?? null,
    tunnelName: config.tunnelName ?? null,
    endpointKey: config.endpointKey ?? null,
    publicHttpBaseUrl: config.publicHttpBaseUrl ?? null,
    relayMultiaddrs: config.relayMultiaddrs ?? [],
    transportMode: config.transportMode ?? null,
    origin: {
      localHttpHost: origin.localHttpHost,
      localHttpPort: origin.localHttpPort,
    },
  });
}

function deriveEndpointKey(config: RelayManagedEndpointRuntimeConfig): string {
  if (config.endpointKey !== undefined && config.endpointKey.length > 0) {
    return config.endpointKey;
  }
  const fromTunnelName = config.tunnelName?.split("-").at(-1);
  if (fromTunnelName !== undefined && fromTunnelName.length > 0) {
    return fromTunnelName;
  }
  if (config.tunnelId !== undefined && config.tunnelId.length > 0) {
    return config.tunnelId;
  }
  return "default";
}

function extractUrlHost(urlString: string | null): string | null {
  if (urlString === null) return null;
  try {
    return new URL(urlString).host;
  } catch {
    return null;
  }
}

function isRegistrationRejectedEvent(event: EnvironmentTunnelStatusEvent): boolean {
  return (
    event.state === "stopped" &&
    event.error !== undefined &&
    /rejected tunnel registration/iu.test(event.error)
  );
}

class TunnelStartFailure extends Schema.TaggedError<TunnelStartFailure>()("TunnelStartFailure", {
  unauthorized: Schema.Boolean,
  reason: Schema.String,
}) {}

const stopConnector = (connector: ActiveConnector | null) =>
  connector
    ? Effect.sync(() => {
        connector.markStopped();
      }).pipe(
        Effect.andThen(Effect.promise(() => connector.tunnel.stop()).pipe(Effect.ignore)),
        Effect.andThen(Scope.close(connector.scope, Exit.void).pipe(Effect.ignore)),
        Effect.tap(() =>
          Effect.logInfo("libp2p tunnel connector stopped", {
            pid: connector.pid,
            peerId: connector.getPeerId() ?? connector.tunnel.peerId,
          }),
        ),
        Effect.ignore,
      )
    : Effect.void;

/** @public */
export const make = Effect.fn("CloudManagedEndpointRuntime.make")(function* (factoryOptions?: {
  readonly createTunnel?: CreateEnvironmentLibp2pTunnelFn;
}) {
  const createTunnel = factoryOptions?.createTunnel ?? createEnvironmentLibp2pTunnel;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const connectAllowed = ManagedLimits.allowsConnect(yield* ManagedPolicy.ManagedPolicy);

  const activeRef = yield* Ref.make<ActiveConnector | null>(null);
  const desiredConfigRef = yield* Ref.make<RelayManagedEndpointRuntimeConfig | null>(null);
  const localOriginRef = yield* Ref.make<RelayManagedEndpointOrigin | null>(null);
  const instanceCounterRef = yield* Ref.make(0);

  const recoveryRequests = yield* Queue.sliding<RelayManagedEndpointRuntimeConfig>(1);
  const tunnelConnections = yield* Queue.sliding<void>(1);
  const readinessChanges = yield* Queue.sliding<void>(1);
  const reconcileSemaphore = yield* Semaphore.make(1);
  const linkStateSemaphore = yield* Semaphore.make(1);

  const relayClientLogPath = path.join(serverConfig.logsDir, RELAY_CLIENT_LOG_FILE);
  const fallbackLoggers = yield* Effect.service(Logger.CurrentLoggers);
  let writeFailureReported = false;
  const relayClientLog = yield* Effect.try({
    try: () =>
      new RotatingFileSink({
        filePath: relayClientLogPath,
        maxBytes: 1024 * 1024,
        maxFiles: 2,
        throwOnError: true,
      }),
    catch: (cause) =>
      isRotatingFileSinkError(cause)
        ? cause
        : new RotatingFileSinkError({
            operation: "initialize",
            filePath: relayClientLogPath,
            cause,
          }),
  }).pipe(
    Effect.map((sink) =>
      Logger.make((options) => {
        try {
          const entry = Logger.formatJson.log(options);
          const bytes = Buffer.byteLength(entry) + 1;
          sink.write(
            bytes <= 1024 * 1024
              ? `${entry}\n`
              : `${JSON.stringify({
                  timestamp: options.date.toISOString(),
                  level: options.logLevel.toUpperCase(),
                  message: ["Relay client log entry omitted: exceeds 1 MiB", { bytes }],
                })}\n`,
          );
        } catch {
          if (!writeFailureReported) {
            writeFailureReported = true;
            for (const logger of fallbackLoggers) {
              logger.log({
                ...options,
                logLevel: "Warn",
                message: ["Relay client log unavailable", { filePath: relayClientLogPath }],
              });
            }
          }
        }
      }),
    ),
    Effect.catch((error) =>
      Effect.logWarning("Relay client log unavailable", {
        filePath: relayClientLogPath,
        cause: error,
      }).pipe(Effect.as(undefined)),
    ),
  );
  const withRelayClientLog = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    relayClientLog ? Effect.withLogger(effect, relayClientLog) : effect;

  const stopActive = Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRef, null);
    yield* stopConnector(active);
  });

  const resolveEffectiveOrigin = Effect.fn("CloudManagedEndpointRuntime.resolveEffectiveOrigin")(
    function* (explicitOrigin?: RelayManagedEndpointOrigin) {
      if (explicitOrigin !== undefined) {
        yield* Ref.set(localOriginRef, explicitOrigin);
        return explicitOrigin;
      }
      const storedOrigin = yield* Ref.get(localOriginRef);
      if (storedOrigin !== null) {
        return storedOrigin;
      }
      const confirmedBytes = yield* secrets
        .get(CLOUD_ENDPOINT_CONFIRMED_ORIGIN)
        .pipe(Effect.orElseSucceed(Option.none));
      if (Option.isSome(confirmedBytes)) {
        const decoded = decodeConfirmedOrigin(new TextDecoder().decode(confirmedBytes.value));
        if (Option.isSome(decoded)) {
          return decoded.value.origin;
        }
      }
      return {
        localHttpHost: "127.0.0.1",
        localHttpPort: serverConfig.port > 0 ? serverConfig.port : 3773,
      } satisfies RelayManagedEndpointOrigin;
    },
  );

  const resolveRelayUrl = Effect.gen(function* () {
    const secretUrl = yield* secrets.get(RELAY_URL_SECRET).pipe(Effect.orElseSucceed(Option.none));
    if (Option.isSome(secretUrl)) {
      const normalized = normalizeSecureRelayUrl(new TextDecoder().decode(secretUrl.value));
      if (normalized !== null) return normalized;
    }
    return Option.getOrNull(yield* relayUrlConfig.pipe(Effect.option));
  });

  const fetchControlPlaneConfig = Effect.fn("CloudManagedEndpointRuntime.fetchControlPlaneConfig")(
    function* (relayUrl: string) {
      return yield* httpClient
        .get(`${relayUrl}/.well-known/cove-control-plane`)
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayControlPlanePublicConfig)),
          Effect.scoped,
          Effect.withTracerEnabled(false),
          Effect.timeout(CONTROL_PLANE_DISCOVERY_TIMEOUT),
        );
    },
  );

  const reconcileConfig = Effect.fn("CloudManagedEndpointRuntime.reconcileConfig")(function* (
    config: RelayManagedEndpointRuntimeConfig | null,
    options?: { readonly origin?: RelayManagedEndpointOrigin },
  ) {
    if (!connectAllowed || !config || config.providerKind !== "libp2p_tunnel") {
      yield* stopActive;
      return !connectAllowed || !config
        ? ({ status: "disabled" } satisfies CloudManagedEndpointRuntimeStatus)
        : ({
            status: "unsupported",
            providerKind: config.providerKind,
          } satisfies CloudManagedEndpointRuntimeStatus);
    }

    const origin = yield* resolveEffectiveOrigin(options?.origin);
    const nextConfigKey = runtimeConfigKey(config, origin);
    const active = yield* Ref.get(activeRef);
    if (active?.configKey === nextConfigKey) {
      return {
        status: "running",
        providerKind: "libp2p_tunnel",
        pid: active.pid,
        ...(active.config.tunnelId ? { tunnelId: active.config.tunnelId } : {}),
        ...(active.config.tunnelName ? { tunnelName: active.config.tunnelName } : {}),
        ...(active.getPeerId() !== null
          ? { peerId: active.getPeerId() ?? active.tunnel.peerId }
          : { peerId: active.tunnel.peerId }),
      } satisfies CloudManagedEndpointRuntimeStatus;
    }

    yield* stopActive;

    const relayUrl = yield* resolveRelayUrl;
    let relayMultiaddrs: readonly string[] = config.relayMultiaddrs ?? [];
    if (relayMultiaddrs.length === 0 && relayUrl !== null) {
      const discovered = yield* fetchControlPlaneConfig(relayUrl).pipe(Effect.option);
      if (Option.isSome(discovered) && discovered.value.libp2p.enabled) {
        relayMultiaddrs = discovered.value.libp2p.relayMultiaddrs;
      }
    }
    if (relayMultiaddrs.length === 0) {
      const reason = "Control plane did not advertise any libp2p relay multiaddrs.";
      yield* Effect.logWarning(reason, {
        tunnelId: config.tunnelId,
        tunnelName: config.tunnelName,
      });
      return {
        status: "failed",
        providerKind: "libp2p_tunnel",
        failure: "spawn-failed",
        reason,
        ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
        ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
      } satisfies CloudManagedEndpointRuntimeStatus;
    }

    const endpointKey = deriveEndpointKey(config);
    const endpointId = config.tunnelId ?? endpointKey;
    const publicHttpBaseUrl =
      config.publicHttpBaseUrl ??
      (relayUrl !== null ? `${relayUrl.replace(/\/+$/u, "")}/t/${endpointKey}/` : null);
    const hostname = extractUrlHost(publicHttpBaseUrl);
    const originUrl = formatOriginUrl(origin);
    const keyPath = path.join(serverConfig.stateDir, "libp2p-environment.key");

    let stopped = false;
    let attached = false;
    let readyConnections: number | null = 0;
    let peerId: string | null = null;
    let pendingReadinessSignal = false;
    let pendingConnectedSignal = false;
    const statusLogQueue = yield* Queue.unbounded<EnvironmentTunnelStatusEvent>();

    const onStatusChange = (event: EnvironmentTunnelStatusEvent) => {
      if (stopped) return;
      readyConnections = event.state === "connected" ? 1 : 0;
      peerId = event.peerId;
      Queue.offerUnsafe(statusLogQueue, event);
      if (!attached) {
        pendingReadinessSignal = true;
        if (event.state === "connected") {
          pendingConnectedSignal = true;
        }
        return;
      }
      Queue.offerUnsafe(readinessChanges, undefined);
      if (event.state === "connected") {
        Queue.offerUnsafe(tunnelConnections, undefined);
      } else if (isRegistrationRejectedEvent(event)) {
        Queue.offerUnsafe(recoveryRequests, config);
      }
    };

    const startOutcome = yield* Effect.tryPromise({
      try: () =>
        createTunnel({
          relayMultiaddrs,
          endpointId,
          endpointKey,
          connectorToken: config.connectorToken,
          localHost: origin.localHttpHost,
          localPort: origin.localHttpPort,
          enableP2p: config.transportMode !== "relay",
          keyPath,
          onStatusChange,
        }),
      catch: (cause) =>
        new TunnelStartFailure({
          unauthorized: cause instanceof TunnelRegistrationUnauthorizedError,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(Effect.result);

    if (startOutcome._tag === "Failure") {
      stopped = true;
      const { unauthorized, reason } = startOutcome.failure;
      yield* Effect.logWarning("Failed to start libp2p tunnel connector", {
        reason,
        tunnelId: config.tunnelId,
        tunnelName: config.tunnelName,
      });
      if (unauthorized) {
        yield* Queue.offer(recoveryRequests, config);
      }
      return {
        status: "failed",
        providerKind: "libp2p_tunnel",
        failure: "spawn-failed",
        reason,
        ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
        ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
      } satisfies CloudManagedEndpointRuntimeStatus;
    }

    const tunnel = startOutcome.success;
    const connectorScope = yield* Scope.make("sequential");
    const pid = yield* Ref.updateAndGet(instanceCounterRef, (n) => n + 1);

    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const connector: ActiveConnector = {
          pid,
          tunnel,
          scope: connectorScope,
          configKey: nextConfigKey,
          config,
          originUrl,
          publicHttpBaseUrl,
          hostname,
          getReadyConnections: () => readyConnections,
          getPeerId: () => peerId ?? tunnel.peerId,
          markStopped: () => {
            stopped = true;
          },
        };
        yield* Ref.set(activeRef, connector);
        attached = true;
        if (pendingReadinessSignal) {
          Queue.offerUnsafe(readinessChanges, undefined);
        }
        if (pendingConnectedSignal) {
          Queue.offerUnsafe(tunnelConnections, undefined);
        }
        yield* Effect.forkIn(
          restore(
            Stream.fromQueue(statusLogQueue).pipe(
              Stream.runForEach((event) =>
                event.state === "connected"
                  ? Effect.logInfo("libp2p tunnel connector connected", {
                      pid,
                      peerId: event.peerId,
                      tunnelId: config.tunnelId,
                      tunnelName: config.tunnelName,
                    })
                  : Effect.logWarning("libp2p tunnel status changed", {
                      pid,
                      state: event.state,
                      peerId: event.peerId,
                      ...(event.error ? { error: event.error } : {}),
                    }),
              ),
              Effect.ignoreCause,
            ),
          ),
          connectorScope,
        );
      }),
    );

    yield* Effect.logInfo("libp2p tunnel connector started", {
      pid,
      peerId: tunnel.peerId,
      originUrl,
      publicHttpBaseUrl,
      tunnelId: config.tunnelId,
      tunnelName: config.tunnelName,
    });

    return {
      status: "running",
      providerKind: "libp2p_tunnel",
      pid,
      peerId: tunnel.peerId,
      ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
      ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
    } satisfies CloudManagedEndpointRuntimeStatus;
  });

  const applyConfig: CloudManagedEndpointRuntime["Service"]["applyConfig"] = Effect.fn(
    "CloudManagedEndpointRuntime.applyConfig",
  )(function* (requested, options) {
    return yield* reconcileSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const config = connectAllowed ? requested : null;
        yield* Ref.set(desiredConfigRef, config);
        return yield* reconcileConfig(config, options);
      }),
    );
  }, withRelayClientLog);

  const setLocalOrigin: CloudManagedEndpointRuntime["Service"]["setLocalOrigin"] = Effect.fn(
    "CloudManagedEndpointRuntime.setLocalOrigin",
  )(function* (origin) {
    yield* Ref.set(localOriginRef, origin);
  });

  const restartConnector = Effect.fn("CloudManagedEndpointRuntime.restartConnector")(function* (
    pid: number,
    stillDead: Effect.Effect<boolean>,
  ) {
    const active = yield* Ref.get(activeRef);
    if (!active || active.pid !== pid || !(yield* stillDead)) return false;
    yield* Effect.logWarning(
      "Relay has no live libp2p connection from this connector; restarting it",
      { pid, tunnelId: active.config.tunnelId, tunnelName: active.config.tunnelName },
    );
    yield* stopActive;
    const desired = yield* Ref.get(desiredConfigRef);
    if (!desired || desired.providerKind !== "libp2p_tunnel") return false;
    yield* reconcileConfig(desired);
    return true;
  }, reconcileSemaphore.withPermits(1));

  const inspectConnector = Effect.gen(function* () {
    const active = yield* Ref.get(activeRef);
    if (!active) return null;
    return {
      pid: active.pid,
      readyConnections: active.getReadyConnections(),
      hostname: active.hostname,
      origin: active.originUrl,
      protocol: "libp2p",
      publicHttpBaseUrl: active.publicHttpBaseUrl,
      peerId: active.getPeerId(),
    } satisfies ConnectorFacts;
  });

  const runtime = CloudManagedEndpointRuntime.of({
    applyConfig,
    setLocalOrigin,
    inspectConnector,
    readinessChanged: Stream.fromQueue(readinessChanges),
    recoveryRequests: Stream.fromQueue(recoveryRequests),
    requestRecovery: Effect.fn("CloudManagedEndpointRuntime.requestRecovery")(function (config) {
      return Queue.offer(recoveryRequests, config).pipe(Effect.asVoid);
    }),
    restartConnector,
    tunnelConnected: Stream.fromQueue(tunnelConnections),
    withLinkStateLock: linkStateSemaphore.withPermits(1),
  });

  yield* Effect.addFinalizer(() => runtime.applyConfig(null));
  return runtime;
});

export const layer = Layer.effect(CloudManagedEndpointRuntime, make());

export const layerWithFactory = (createTunnel: CreateEnvironmentLibp2pTunnelFn) =>
  Layer.effect(CloudManagedEndpointRuntime, make({ createTunnel }));
