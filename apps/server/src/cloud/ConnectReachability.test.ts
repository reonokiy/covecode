// @effect-diagnostics nodeBuiltinImport:off - reads the user guide to check its anchors.
import * as NodeFS from "node:fs";

import { T3_CONNECT_TROUBLESHOOTING_SECTIONS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG, RELAY_URL_SECRET } from "./config.ts";
import * as ConnectReachability from "./ConnectReachability.ts";
import { classifyReachability, type ReachabilityFacts } from "./ConnectReachability.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

const checkedAt = "2026-10-19T00:00:00.000Z";
const connected: ManagedEndpointRuntime.ConnectorFacts = {
  pid: 1,
  readyConnections: 1,
  hostname: "relay.example.test",
  origin: "http://127.0.0.1:3773",
  protocol: "libp2p",
  publicHttpBaseUrl: "https://relay.example.test/t/0123456789abcdef/",
  peerId: "12D3KooWEnvPeer",
};
const notConnected: ManagedEndpointRuntime.ConnectorFacts = {
  pid: 1,
  readyConnections: 0,
  hostname: null,
  origin: null,
  protocol: "libp2p",
  publicHttpBaseUrl: null,
};
const facts = (overrides: Partial<ReachabilityFacts>): ReachabilityFacts => ({
  managedTunnelConfigured: true,
  connector: connected,
  endpoint: null,
  edgeReachable: null,
  exitNode: null,
  ...overrides,
});

describe("classifyReachability", () => {
  it.each([
    [{ kind: "status", status: 502 }, "origin_unreachable"],
    [
      { kind: "status", status: 502, relayErrorCode: "tunnel_upstream_failed" },
      "origin_unreachable",
    ],
    [{ kind: "status", status: 502, relayErrorCode: "tunnel_unavailable" }, "no_connector"],
    [{ kind: "status", status: 502, relayErrorCode: "libp2p_disabled" }, "no_connector"],
    [{ kind: "status", status: 503, relayErrorCode: "tunnel_unavailable" }, "no_connector"],
    [{ kind: "status", status: 500 }, "unexpected_response"],
    [{ kind: "dns_failed" }, "dns_failed"],
    [{ kind: "network_error" }, "timeout"],
  ] as const)("maps endpoint result %o to %s", (endpoint, cause) => {
    expect(classifyReachability(facts({ endpoint, edgeReachable: true }), checkedAt)).toMatchObject(
      { status: "unreachable", cause },
    );
  });

  it("reports edge_unreachable when control plane /health fails and connector is not ready", () => {
    expect(
      classifyReachability(
        facts({
          connector: notConnected,
          endpoint: { kind: "timeout" },
          edgeReachable: false,
        }),
        checkedAt,
      ),
    ).toMatchObject({ status: "unreachable", cause: "edge_unreachable" });
  });

  it("keeps the endpoint cause when the connector is connected", () => {
    expect(
      classifyReachability(
        facts({ endpoint: { kind: "status", status: 502 }, edgeReachable: false }),
        checkedAt,
      ),
    ).toMatchObject({ cause: "origin_unreachable" });
    expect(
      classifyReachability(
        facts({
          connector: {
            pid: 1,
            readyConnections: null,
            hostname: "relay.example.test",
            origin: null,
            protocol: "libp2p",
          },
          endpoint: { kind: "dns_failed" },
          edgeReachable: false,
        }),
        checkedAt,
      ),
    ).toMatchObject({ cause: "dns_failed" });
  });

  it("waits on a connector that has not connected while the relay answers", () => {
    expect(
      classifyReachability(facts({ connector: notConnected, edgeReachable: true }), checkedAt),
    ).toMatchObject({ cause: "connector_not_ready" });
  });

  it("does not point an unlinked server at a background service it may not have", () => {
    const result = classifyReachability(facts({ managedTunnelConfigured: false }), checkedAt);
    expect(result).toMatchObject({ cause: "not_linked" });
    expect(result.status === "unreachable" && result.fix).not.toContain("t3 service");
  });
});

interface ServedResponse {
  readonly status: number;
  readonly body: string | ReadableStream<Uint8Array>;
}

type Served = Effect.Effect<ServedResponse, HttpClientError.HttpClientError>;

const encode = (value: string) => new TextEncoder().encode(value);

const reachabilityLayer = (
  respond: Served | ((request: HttpClientRequest.HttpClientRequest) => Served),
  restartConnector: (pid: number, stillDead: Effect.Effect<boolean>) => Effect.Effect<boolean>,
) =>
  ConnectReachability.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({
          inspectConnector: Effect.succeed(connected),
          readinessChanged: Stream.never,
          restartConnector,
        }),
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) => {
            if (name === CLOUD_ENDPOINT_RUNTIME_CONFIG) {
              return Effect.succeedSome(encode("{}"));
            }
            if (name === RELAY_URL_SECRET) {
              return Effect.succeedSome(encode("https://relay.example.test"));
            }
            return Effect.succeedNone;
          },
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            if (request.url.endsWith("/health")) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, Response.json({ ok: true })),
              );
            }
            return (Effect.isEffect(respond) ? respond : respond(request)).pipe(
              Effect.map(({ status, body }) =>
                HttpClientResponse.fromWeb(request, new Response(body, { status })),
              ),
            );
          }),
        ),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("no tailscale")),
        ),
      ),
    ),
  );

describe("ConnectReachability stale connector recovery", () => {
  it.effect("restarts the connector when the relay has no tunnel while it reports ready", () =>
    Effect.gen(function* () {
      const restarts = yield* Queue.unbounded<number>();
      let status = 502;
      let errorCode = "tunnel_unavailable";
      const layer = reachabilityLayer(
        Effect.sync(() => ({
          status,
          body: JSON.stringify({ error: errorCode }),
        })),
        (pid, stillDead) =>
          stillDead.pipe(Effect.tap((dead) => (dead ? Queue.offer(restarts, pid) : Effect.void))),
      );
      yield* Effect.gen(function* () {
        const reachability = yield* ConnectReachability.ConnectReachability;

        expect(yield* reachability.check).toMatchObject({ cause: "no_connector" });
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Queue.size(restarts)).toBe(0);
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Queue.take(restarts)).toBe(connected.pid);

        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Queue.size(restarts)).toBe(0);
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Queue.take(restarts)).toBe(connected.pid);

        // Reaching the endpoint resets the wait, and an upstream origin error is not treated as no_connector.
        status = 200;
        expect(yield* reachability.check).toMatchObject({ status: "reachable" });
        status = 502;
        errorCode = "tunnel_upstream_failed";
        expect(yield* reachability.check).toMatchObject({ cause: "origin_unreachable" });
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Queue.size(restarts)).toBe(0);

        errorCode = "tunnel_unavailable";
        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Queue.take(restarts)).toBe(connected.pid);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("starts a new streak after a healthy check that a newer check overtook", () =>
    Effect.gen(function* () {
      const restartTimes = yield* Queue.unbounded<number>();
      const healthyRequested = yield* Deferred.make<void>();
      const healthyAnswer = yield* Deferred.make<void>();
      let status = 502;
      const layer = reachabilityLayer(
        Effect.gen(function* () {
          const served = status;
          if (served === 200) {
            yield* Deferred.succeed(healthyRequested, undefined);
            yield* Deferred.await(healthyAnswer);
          }
          return {
            status: served,
            body: JSON.stringify({ error: "tunnel_unavailable" }),
          };
        }),
        (_pid, stillDead) =>
          stillDead.pipe(
            Effect.tap((dead) =>
              dead
                ? Clock.currentTimeMillis.pipe(
                    Effect.flatMap((now) => Queue.offer(restartTimes, now)),
                  )
                : Effect.void,
            ),
          ),
      );
      yield* Effect.gen(function* () {
        const reachability = yield* ConnectReachability.ConnectReachability;
        const startedAt = yield* Clock.currentTimeMillis;
        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(1));

        status = 200;
        const healthy = yield* Effect.forkChild(reachability.check);
        yield* Deferred.await(healthyRequested);
        status = 502;
        yield* reachability.check;
        yield* Deferred.succeed(healthyAnswer, undefined);
        expect(yield* Fiber.join(healthy)).toMatchObject({ status: "reachable" });

        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(2));
        expect((yield* Queue.take(restartTimes)) - startedAt).toBe(
          Duration.toMillis(Duration.minutes(3)),
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("rejects a restart when an overtaken healthy check finishes while it waits", () =>
    Effect.gen(function* () {
      const healthyRequested = yield* Deferred.make<void>();
      const healthyAnswer = yield* Deferred.make<void>();
      const restartRequested = yield* Deferred.make<void>();
      const releaseRestart = yield* Deferred.make<void>();
      const guardChecks = yield* Queue.unbounded<boolean>();
      let status = 502;
      const layer = reachabilityLayer(
        Effect.gen(function* () {
          const served = status;
          if (served === 200) {
            yield* Deferred.succeed(healthyRequested, undefined);
            yield* Deferred.await(healthyAnswer);
          }
          return { status: served, body: JSON.stringify({ error: "tunnel_unavailable" }) };
        }),
        (_pid, stillDead) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(restartRequested, undefined);
            yield* Deferred.await(releaseRestart);
            const accepted = yield* stillDead;
            yield* Queue.offer(guardChecks, accepted);
            return accepted;
          }),
      );
      yield* Effect.gen(function* () {
        const reachability = yield* ConnectReachability.ConnectReachability;
        yield* reachability.check;
        yield* TestClock.adjust(Duration.seconds(119));

        status = 200;
        const healthy = yield* Effect.forkChild(reachability.check);
        yield* Deferred.await(healthyRequested);
        status = 502;
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Deferred.await(restartRequested);

        yield* Deferred.succeed(healthyAnswer, undefined);
        expect(yield* Fiber.join(healthy)).toMatchObject({ status: "reachable" });
        yield* Deferred.succeed(releaseRestart, undefined);
        expect(yield* Queue.take(guardChecks)).toBe(false);

        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Queue.size(guardChecks)).toBe(0);
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Queue.take(guardChecks)).toBe(true);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps a 502 whose error body never finishes", () =>
    Effect.gen(function* () {
      let markBodyRead = () => {};
      const bodyRead = new Promise<void>((resolve) => {
        markBodyRead = resolve;
      });
      const layer = reachabilityLayer(
        Effect.sync(() => ({
          status: 502,
          body: new ReadableStream({
            pull: () => {
              markBodyRead();
              return new Promise<void>(() => {});
            },
          }),
        })),
        () => Effect.succeed(false),
      );
      yield* Effect.gen(function* () {
        const reachability = yield* ConnectReachability.ConnectReachability;
        const check = yield* Effect.forkChild(reachability.check);
        yield* Effect.promise(() => bodyRead);
        yield* TestClock.adjust(Duration.seconds(2));
        expect(yield* Fiber.join(check)).toMatchObject({ cause: "origin_unreachable" });
      }).pipe(Effect.provide(layer));
    }),
  );
});

describe("ConnectReachability DNS failures", () => {
  const lookupFailed = (code: string) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request: HttpClientRequest.get("https://relay.example.test/t/0123456789abcdef/"),
          cause: new TypeError("fetch failed", {
            cause: Object.assign(new Error(`getaddrinfo ${code} relay.example.test`), {
              code,
              syscall: "getaddrinfo",
              hostname: "relay.example.test",
            }),
          }),
        }),
      }),
    );

  it.effect("reports getaddrinfo EBUSY/ENOTFOUND/EAI_AGAIN as dns_failed", () =>
    Effect.gen(function* () {
      for (const code of ["EBUSY", "ENOTFOUND", "EAI_AGAIN"]) {
        const layer = reachabilityLayer(lookupFailed(code), () => Effect.succeed(false));
        const result = yield* ConnectReachability.ConnectReachability.use(
          (reachability) => reachability.check,
        ).pipe(Effect.provide(layer));
        expect(result).toMatchObject({ status: "unreachable", cause: "dns_failed" });
      }
    }),
  );
});

describe("T3 Connect troubleshooting links", () => {
  it("each section names a heading in the user guide", () => {
    const guide = NodeFS.readFileSync(
      new URL("../../../../docs/user/t3-connect-troubleshooting.md", import.meta.url),
      "utf8",
    );
    const anchors = new Set(
      [...guide.matchAll(/^#{2,3} (.+)$/gm)].map(([, heading]) =>
        heading!
          .toLowerCase()
          .replace(/[^\p{L}\p{N} _-]/gu, "")
          .replace(/ /g, "-"),
      ),
    );
    for (const section of T3_CONNECT_TROUBLESHOOTING_SECTIONS) {
      expect(anchors, section).toContain(section);
    }
  });
});
