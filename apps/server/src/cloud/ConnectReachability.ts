import {
  connectReachabilityHelpUrl,
  type EnvironmentConnectReachability,
  formatConnectReachable,
} from "@t3tools/contracts";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { readTailscaleExitNode, type TailscaleExitNode } from "@t3tools/tailscale";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG, RELAY_URL_SECRET } from "./config.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import { relayUrlConfig } from "./publicConfig.ts";

const RELAY_HEALTH_TIMEOUT = Duration.seconds(5);
const ENDPOINT_REQUEST_TIMEOUT = Duration.seconds(10);
const ERROR_BODY_READ_TIMEOUT = Duration.seconds(2);
const READINESS_CHANGE_DEBOUNCE = Duration.seconds(3);
const RECHECK_INTERVAL = Duration.minutes(5);
const DEAD_CONNECTOR_RESTART_AFTER = Duration.minutes(2);
const DEAD_CONNECTOR_RESTART_AFTER_MAX = Duration.hours(1);

export type EndpointProbe =
  | { readonly kind: "status"; readonly status: number; readonly relayErrorCode?: string }
  | { readonly kind: "dns_failed" }
  | { readonly kind: "timeout" | "network_error" };

/** Everything one check learned. `null` means that step did not run. */
export interface ReachabilityFacts {
  readonly managedTunnelConfigured: boolean;
  readonly connector: ManagedEndpointRuntime.ConnectorFacts | null;
  readonly endpoint: EndpointProbe | null;
  readonly edgeReachable: boolean | null;
  readonly exitNode: TailscaleExitNode | null;
}

type Unreachable = Extract<EnvironmentConnectReachability, { status: "unreachable" }>;

function exitNodeHint(exitNode: TailscaleExitNode | null): string | null {
  if (!exitNode) return null;
  const name = exitNode.name ? ` "${exitNode.name}"` : "";
  return `Tailscale exit node${name} is on. Traffic to the control plane goes through it.`;
}

/** Turns what one check learned into the answer every surface shows. */
export function classifyReachability(
  facts: ReachabilityFacts,
  checkedAt: string,
): EnvironmentConnectReachability {
  const { connector, endpoint, exitNode } = facts;
  const fail = (
    cause: Unreachable["cause"],
    reason: string,
    fix: string,
    hint: string | null = null,
  ): Unreachable => ({ status: "unreachable", checkedAt, cause, reason, hint, fix });
  const restart = "Restart Cove Code. If it stays, run `t3 connect` again.";

  if (!facts.managedTunnelConfigured) {
    return fail(
      "not_linked",
      "The server has not set up a T3 Connect tunnel.",
      "Run `t3 connect`, then restart Cove Code so it applies the link.",
    );
  }
  if (connector === null) {
    return fail(
      "connector_not_running",
      "The libp2p tunnel connector is not running.",
      "Restart Cove Code. If it stays down, check the server log for relay client errors.",
    );
  }
  const status = endpoint?.kind === "status" ? endpoint.status : null;
  if (status === 200) {
    return {
      status: "reachable",
      checkedAt,
      readyConnections: connector.readyConnections,
      protocol: connector.protocol,
    };
  }
  if (
    facts.edgeReachable === false &&
    status !== 502 &&
    !(connector.readyConnections && connector.readyConnections > 0) &&
    endpoint?.kind !== "dns_failed"
  ) {
    return fail(
      "edge_unreachable",
      "The T3 Connect relay server is unreachable from this machine.",
      exitNode
        ? "tailscale set --exit-node=   (or allow outbound connections to the control plane)"
        : "Check that this machine can reach the T3 Connect control plane, and check any VPN, proxy, or firewall.",
      exitNodeHint(exitNode) ?? "A VPN, proxy, or firewall may block it.",
    );
  }
  const relayErrorCode = endpoint?.kind === "status" ? endpoint.relayErrorCode : undefined;
  if (
    (status === 502 &&
      (relayErrorCode === "tunnel_unavailable" || relayErrorCode === "libp2p_disabled")) ||
    (status === 503 && relayErrorCode === "tunnel_unavailable")
  ) {
    return fail(
      "no_connector",
      "The T3 Connect relay has no live libp2p tunnel connection from this machine.",
      restart,
    );
  }
  if (status === 502) {
    return fail(
      "origin_unreachable",
      "The tunnel is up, but it cannot reach the T3 server on this machine.",
      "Restart Cove Code so the tunnel uses the port the server listens on.",
    );
  }
  if (endpoint === null || connector.readyConnections === 0) {
    return fail(
      "connector_not_ready",
      "The libp2p tunnel connector has not connected to the relay yet.",
      "Wait a minute. If it stays, check the network and the server log.",
    );
  }
  if (status !== null) {
    const code = relayErrorCode === undefined ? "" : ` (${relayErrorCode})`;
    return fail(
      "unexpected_response",
      `The T3 Connect address answered with HTTP ${status}${code}.`,
      restart,
    );
  }
  if (endpoint.kind === "dns_failed") {
    return fail(
      "dns_failed",
      "The T3 Connect address does not resolve from this machine.",
      "Check the DNS settings on this machine or its VPN.",
      exitNodeHint(exitNode),
    );
  }
  return fail(
    "timeout",
    "The T3 Connect address did not answer from this machine.",
    "Check the network, VPN, or proxy on this machine.",
    exitNodeHint(exitNode),
  );
}

/** The loud diagnosis the CLI prints and the server logs. */
export function formatReachabilityFailure(result: Unreachable): string {
  return [
    "✕ T3 Connect is NOT reachable from other devices",
    `  ${result.reason}`,
    ...(result.hint ? [`  ${result.hint}`] : []),
    `  Fix: ${result.fix}`,
    `  More info: ${connectReachabilityHelpUrl(result.cause)}`,
  ].join("\n");
}

function dnsLookupErrorCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
    const code = "code" in current && typeof current.code === "string" ? current.code : "";
    if (("syscall" in current && current.syscall === "getaddrinfo") || DNS_ERROR_CODES.has(code)) {
      return code;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return null;
}

const DNS_ERROR_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EBUSY"]);

const RelayErrorPayloadJson = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.optionalKey(Schema.String),
  }),
);
const decodeRelayErrorPayload = Schema.decodeUnknownOption(RelayErrorPayloadJson);

function originHealthUrl(endpointBase: string): string | null {
  try {
    return `${new URL(endpointBase).origin}/health`;
  } catch {
    return null;
  }
}

export class ConnectReachability extends Context.Service<
  ConnectReachability,
  {
    /** Runs a check now. The server also runs one when the tunnel's readiness changes. */
    readonly check: Effect.Effect<EnvironmentConnectReachability>;
    readonly latest: Effect.Effect<Option.Option<EnvironmentConnectReachability>>;
  }
>()("t3/cloud/ConnectReachability") {}

const make = Effect.gen(function* () {
  const runtime = yield* ManagedEndpointRuntime.CloudManagedEndpointRuntime;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const latestRef = yield* Ref.make(
    Option.none<{ readonly order: number; readonly result: EnvironmentConnectReachability }>(),
  );
  const checkCounter = yield* Ref.make(0);
  const lastHealthyOrder = yield* Ref.make(0);
  const deadConnectorRef = yield* SynchronizedRef.make<{
    readonly streak: {
      readonly pid: number;
      readonly since: number;
      readonly order: number;
    } | null;
    readonly restartAfterMillis: number;
    readonly restartOrder: number;
  }>({
    streak: null,
    restartAfterMillis: Duration.toMillis(DEAD_CONNECTOR_RESTART_AFTER),
    restartOrder: 0,
  });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const readExitNode = readTailscaleExitNode.pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.orElseSucceed(() => null),
  );

  const probeEndpoint = Effect.fn("ConnectReachability.probeEndpoint")(
    function* (endpointBaseUrl: string) {
      const normalizedBase = endpointBaseUrl.endsWith("/")
        ? endpointBaseUrl
        : `${endpointBaseUrl}/`;
      const probeUrl = new URL(".well-known/t3/environment", normalizedBase).toString();
      const response = yield* httpClient
        .get(probeUrl, { acceptJson: true })
        .pipe(Effect.timeoutOption(ENDPOINT_REQUEST_TIMEOUT));
      if (Option.isNone(response)) return { kind: "timeout" } satisfies EndpointProbe;
      const { status } = response.value;
      if (status !== 502 && status !== 503) {
        return { kind: "status", status } satisfies EndpointProbe;
      }
      const body = yield* response.value.text.pipe(
        Effect.timeoutOption(ERROR_BODY_READ_TIMEOUT),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
      const decoded = Option.flatMap(body, decodeRelayErrorPayload);
      const relayErrorCode = Option.isSome(decoded) ? decoded.value.error : undefined;
      return (
        relayErrorCode === undefined
          ? { kind: "status", status }
          : { kind: "status", status, relayErrorCode }
      ) satisfies EndpointProbe;
    },
    Effect.scoped,
    (effect) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.succeed<EndpointProbe>(
            dnsLookupErrorCode(error) !== null ? { kind: "dns_failed" } : { kind: "network_error" },
          ),
        ),
      ),
  );

  const resolveHealthUrl = Effect.fn("ConnectReachability.resolveHealthUrl")(function* (
    endpointBase: string | null,
  ) {
    const storedRelayUrl = yield* secrets
      .get(RELAY_URL_SECRET)
      .pipe(Effect.orElseSucceed(Option.none));
    if (Option.isSome(storedRelayUrl)) {
      const normalized = normalizeSecureRelayUrl(new TextDecoder().decode(storedRelayUrl.value));
      if (normalized !== null) {
        return `${normalized}/health`;
      }
    }
    const configuredRelayUrl = Option.getOrNull(yield* relayUrlConfig.pipe(Effect.option));
    if (configuredRelayUrl !== null) {
      return `${configuredRelayUrl}/health`;
    }
    if (endpointBase !== null) {
      return originHealthUrl(endpointBase);
    }
    return null;
  });

  const probeRelayHealth = Effect.fn("ConnectReachability.probeRelayHealth")(
    function* (healthUrl: string) {
      const response = yield* httpClient
        .get(healthUrl, { acceptJson: true })
        .pipe(Effect.timeoutOption(RELAY_HEALTH_TIMEOUT));
      return Option.isSome(response) && response.value.status >= 200 && response.value.status < 300;
    },
    Effect.scoped,
    (effect) => effect.pipe(Effect.orElseSucceed(() => false)),
  );

  const gatherFacts = Effect.gen(function* () {
    const managedTunnelConfigured = Option.isSome(
      yield* secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG).pipe(Effect.orElseSucceed(Option.none)),
    );
    const connector = managedTunnelConfigured ? yield* runtime.inspectConnector : null;
    const endpointBase =
      connector?.publicHttpBaseUrl ??
      (connector?.hostname ? `https://${connector.hostname}/` : null);
    const endpoint =
      endpointBase !== null && connector?.readyConnections !== 0
        ? yield* probeEndpoint(endpointBase)
        : null;
    const facts: ReachabilityFacts = {
      managedTunnelConfigured,
      connector,
      endpoint,
      edgeReachable: null,
      exitNode: null,
    };
    if (connector === null || (endpoint?.kind === "status" && endpoint.status === 200)) {
      return facts;
    }
    const healthUrl = yield* resolveHealthUrl(endpointBase);
    const [edgeReachable, exitNode] = yield* Effect.all(
      [
        healthUrl === null ? Effect.succeed<boolean | null>(null) : probeRelayHealth(healthUrl),
        readExitNode,
      ],
      { concurrency: 2 },
    );
    return { ...facts, edgeReachable, exitNode };
  });

  const isLatest = (order: number) =>
    Ref.get(latestRef).pipe(
      Effect.map((latest) => Option.isNone(latest) || latest.value.order <= order),
    );

  const restartDeadConnector = Effect.fnUntraced(function* (
    facts: ReachabilityFacts,
    result: EnvironmentConnectReachability,
    order: number,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const { connector } = facts;
    const dead =
      result.status === "unreachable" &&
      result.cause === "no_connector" &&
      connector !== null &&
      (connector.readyConnections ?? 0) > 0
        ? connector
        : null;
    return yield* SynchronizedRef.modifyEffect(deadConnectorRef, (current) =>
      Effect.gen(function* () {
        const healthy = yield* Ref.get(lastHealthyOrder);
        const state = {
          streak: current.streak && current.streak.order > healthy ? current.streak : null,
          restartAfterMillis:
            current.restartOrder > healthy
              ? current.restartAfterMillis
              : Duration.toMillis(DEAD_CONNECTOR_RESTART_AFTER),
          restartOrder: current.restartOrder,
        };
        if (!(yield* isLatest(order))) return [null, state] as const;
        if (dead === null) return [null, { ...state, streak: null }] as const;
        if (state.streak?.pid !== dead.pid) {
          const started = { ...state, streak: { pid: dead.pid, since: now, order } };
          return [{ order, after: Duration.millis(state.restartAfterMillis) }, started] as const;
        }
        if (now - state.streak.since < state.restartAfterMillis) return [null, state] as const;
        const streakOrder = state.streak.order;
        const stillDead = Effect.gen(function* () {
          if (!(yield* isLatest(order))) return false;
          return (yield* Ref.get(lastHealthyOrder)) < streakOrder;
        });
        if (!(yield* runtime.restartConnector(dead.pid, stillDead))) {
          return [null, state] as const;
        }
        const restarted = {
          streak: null,
          restartAfterMillis: Math.min(
            state.restartAfterMillis * 2,
            Duration.toMillis(DEAD_CONNECTOR_RESTART_AFTER_MAX),
          ),
          restartOrder: order,
        };
        return [null, restarted] as const;
      }),
    );
  });

  const check: Effect.Effect<EnvironmentConnectReachability> = Effect.gen(function* () {
    const order = yield* Ref.updateAndGet(checkCounter, (count) => count + 1);
    const facts = yield* gatherFacts;
    const result = classifyReachability(facts, DateTime.formatIso(yield* DateTime.now));
    if (result.status === "reachable") {
      yield* Ref.update(lastHealthyOrder, (healthy) => Math.max(healthy, order));
    }
    const previous = yield* Ref.modify(latestRef, (current) =>
      Option.isSome(current) && current.value.order > order
        ? [null, current]
        : [current, Option.some({ order, result })],
    );
    if (previous === null) return result;
    const started = yield* restartDeadConnector(facts, result, order);
    if (started !== null) {
      const confirm = SynchronizedRef.get(deadConnectorRef).pipe(
        Effect.flatMap(({ streak }) =>
          streak?.order === started.order ? Effect.suspend(() => check) : Effect.void,
        ),
      );
      yield* Effect.sleep(started.after).pipe(Effect.andThen(confirm), Effect.forkIn(scope));
    }
    const changed = Option.match(previous, {
      onNone: () => true,
      onSome: ({ result: last }) =>
        last.status !== result.status ||
        (last.status === "unreachable" &&
          result.status === "unreachable" &&
          last.cause !== result.cause),
    });
    if (!changed || (result.status === "unreachable" && result.cause === "not_linked")) {
      return result;
    }
    if (result.status === "unreachable") {
      const log = result.cause === "connector_not_ready" ? Effect.logWarning : Effect.logError;
      yield* log(`\n${formatReachabilityFailure(result)}`).pipe(
        Effect.annotateLogs({ cause: result.cause }),
      );
    } else {
      yield* Effect.logInfo(
        `T3 Connect is reachable from other devices. ${formatConnectReachable(result)}`,
      );
    }
    return result;
  }).pipe(Effect.withSpan("ConnectReachability.check"));

  yield* runtime.readinessChanged.pipe(
    Stream.debounce(READINESS_CHANGE_DEBOUNCE),
    Stream.runForEach(() => check),
    Effect.forkScoped,
  );
  yield* Effect.sleep(RECHECK_INTERVAL).pipe(
    Effect.andThen(check),
    Effect.forever,
    Effect.forkScoped,
  );

  return ConnectReachability.of({
    check,
    latest: Ref.get(latestRef).pipe(Effect.map(Option.map(({ result }) => result))),
  });
});

export const layer = Layer.effect(ConnectReachability, make);
