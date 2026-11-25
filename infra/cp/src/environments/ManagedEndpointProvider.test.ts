import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";
import { makeTestRelayConfiguration } from "../testConfig.ts";
import { verifyTunnelConnectorToken } from "./Libp2pTunnelRegistry.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

const isOriginNotAllowed = Schema.is(ManagedEndpointProvider.ManagedEndpointOriginNotAllowed);
const isLimitExceeded = Schema.is(ManagedTunnelLimits.ManagedTunnelLimitExceeded);

interface AllocationHarnessOptions {
  readonly existing?: ManagedEndpointAllocations.ManagedEndpointAllocation | null;
  readonly maxTunnels?: number;
  readonly activeOtherTunnels?: number;
  readonly configOverrides?: Partial<RelayConfiguration.RelayConfiguration["Service"]>;
}

function makeHarness(options: AllocationHarnessOptions = {}) {
  let allocation: ManagedEndpointAllocations.ManagedEndpointAllocation | null =
    options.existing ?? null;
  const calls: Array<string> = [];
  const tunnelSecret = "unit-test-tunnel-secret";
  const config = makeTestRelayConfiguration({
    relayIssuer: "https://relay.example.test",
    managedEndpointNamespace: "testns",
    managedEndpointBaseDomain: undefined,
    libp2p: {
      enabled: true,
      listenMultiaddrs: [],
      announceMultiaddrs: ["/dns4/relay.example.test/tcp/4002/wss"],
      tunnelSecret: Redacted.make(tunnelSecret),
    },
    ...options.configOverrides,
  });

  const allocationsLayer = Layer.mock(ManagedEndpointAllocations.ManagedEndpointAllocations, {
    get: () =>
      Effect.sync(() => {
        calls.push("get");
        return allocation;
      }),
    reserve: (input) =>
      Effect.sync(() => {
        calls.push("reserve");
        const now = "2026-10-01T00:00:00.000Z";
        allocation = {
          userId: input.userId,
          environmentId: input.environmentId,
          hostname: input.hostname,
          tunnelId: allocation?.tunnelId ?? null,
          tunnelName: input.tunnelName,
          dnsRecordId: allocation?.dnsRecordId ?? null,
          readyAt: allocation?.readyAt ?? null,
          origin: allocation?.origin ?? null,
          updatedAt: now,
          generation: (allocation?.generation ?? 0) + 1,
          tunnelReleasedAt: allocation?.tunnelReleasedAt ?? null,
        };
        return allocation;
      }),
    recordTunnel: (input) =>
      Effect.sync(() => {
        calls.push("recordTunnel");
        if (!allocation || allocation.generation !== input.generation) return null;
        allocation = {
          ...allocation,
          tunnelId: input.tunnelId,
          tunnelReleasedAt: null,
          generation: allocation.generation + 1,
        };
        return allocation.generation;
      }),
    recordDns: (input) =>
      Effect.sync(() => {
        calls.push("recordDns");
        if (!allocation || allocation.generation !== input.generation) return null;
        allocation = {
          ...allocation,
          dnsRecordId: input.dnsRecordId,
          generation: allocation.generation + 1,
        };
        return allocation.generation;
      }),
    markReady: (input) =>
      Effect.sync(() => {
        calls.push("markReady");
        if (!allocation || allocation.generation !== input.generation) return false;
        allocation = {
          ...allocation,
          readyAt: "2026-10-01T00:00:01.000Z",
          origin: input.origin,
          generation: allocation.generation + 1,
        };
        return true;
      }),
    claimRelease: (input) =>
      Effect.sync(() => {
        calls.push("claimRelease");
        if (
          !allocation ||
          allocation.tunnelId !== input.tunnelId ||
          allocation.generation !== input.generation
        ) {
          return null;
        }
        allocation = {
          ...allocation,
          readyAt: null,
          tunnelReleasedAt: input.markReleased === false ? null : "2026-10-01T00:01:00.000Z",
          generation: allocation.generation + 1,
        };
        return allocation.generation;
      }),
    claimDeprovision: (input) =>
      Effect.sync(() => {
        calls.push("claimDeprovision");
        if (!allocation || allocation.generation !== input.generation) return null;
        allocation = {
          ...allocation,
          generation: allocation.generation + 1,
        };
        return allocation.generation;
      }),
    removeClaimed: (input) =>
      Effect.sync(() => {
        calls.push("removeClaimed");
        if (!allocation || allocation.generation !== input.generation) return false;
        allocation = null;
        return true;
      }),
  });

  const limitsLayer = Layer.mock(ManagedTunnelLimits.ManagedTunnelLimits, {
    getOverride: () => Effect.succeed(null),
    withCapacity: (input, reserve) =>
      Effect.gen(function* () {
        const active = options.activeOtherTunnels ?? 0;
        const max = options.maxTunnels ?? 5;
        if (active >= max) {
          return yield* new ManagedTunnelLimits.ManagedTunnelLimitExceeded({
            userId: input.userId,
            environmentId: input.environmentId,
            maxTunnels: max,
            activeTunnels: active,
          });
        }
        return yield* reserve;
      }),
  });

  const providerLayer = ManagedEndpointProvider.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        RelayConfiguration.layer(config),
        allocationsLayer,
        limitsLayer,
        NodeCrypto.layer,
      ),
    ),
  );

  return {
    providerLayer,
    tunnelSecret,
    calls,
    getAllocation: () => allocation,
  };
}

describe("ManagedEndpointProvider", () => {
  it.effect("provisions a libp2p path-prefix managed endpoint with derived connector token", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* provider.provision({
        userId: "user-1",
        environmentId: "env-1",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });

      const allocation = h.getAllocation();
      expect(allocation).not.toBeNull();
      expect(allocation?.readyAt).not.toBeNull();
      expect(allocation?.dnsRecordId).toBe("libp2p");
      expect(allocation?.tunnelId).toMatch(/^libp2p-/);

      const endpointKey = result.runtime.endpointKey!;
      expect(result.endpoint).toEqual({
        httpBaseUrl: `https://relay.example.test/t/${endpointKey}/`,
        wsBaseUrl: `wss://relay.example.test/t/${endpointKey}/ws`,
        providerKind: "libp2p_tunnel",
        libp2pRelayMultiaddrs: ["/dns4/relay.example.test/tcp/4002/wss"],
        transportMode: "p2p",
      });
      expect(result.runtime.providerKind).toBe("libp2p_tunnel");
      expect(
        verifyTunnelConnectorToken(h.tunnelSecret, {
          endpointKey,
          tunnelId: result.runtime.tunnelId!,
          environmentId: "env-1",
          connectorToken: result.runtime.connectorToken,
        }),
      ).toBe(true);
    }).pipe(Effect.provide(h.providerLayer));
  });

  it.effect("provisions subdomain URLs when managedEndpointBaseDomain is configured", () => {
    const h = makeHarness({
      configOverrides: {
        managedEndpointBaseDomain: "tunnels.example.test",
      },
    });
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const result = yield* provider.provision({
        userId: "user-1",
        environmentId: "env-1",
        origin: { localHttpHost: "localhost", localHttpPort: 3773 },
      });
      const endpointKey = result.runtime.endpointKey!;
      expect(result.endpoint.httpBaseUrl).toBe(`https://${endpointKey}.tunnels.example.test/`);
      expect(result.endpoint.wsBaseUrl).toBe(`wss://${endpointKey}.tunnels.example.test/ws`);
    }).pipe(Effect.provide(h.providerLayer));
  });

  it.effect("rejects non-loopback origins and invalid ports before reserving capacity", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const badHost = yield* Effect.result(
        provider.provision({
          userId: "user-1",
          environmentId: "env-1",
          origin: { localHttpHost: "192.168.1.25", localHttpPort: 3773 },
        }),
      );
      expect(Result.isFailure(badHost)).toBe(true);
      if (Result.isFailure(badHost)) {
        expect(isOriginNotAllowed(badHost.failure)).toBe(true);
      }

      const badPort = yield* Effect.result(
        provider.provision({
          userId: "user-1",
          environmentId: "env-1",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 70_000 },
        }),
      );
      expect(Result.isFailure(badPort)).toBe(true);
      if (Result.isFailure(badPort)) {
        expect(isOriginNotAllowed(badPort.failure)).toBe(true);
      }
      expect(h.calls).toEqual([]);
    }).pipe(Effect.provide(h.providerLayer));
  });

  it.effect("propagates managed tunnel capacity limits", () => {
    const h = makeHarness({ maxTunnels: 2, activeOtherTunnels: 2 });
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const outcome = yield* Effect.result(
        provider.provision({
          userId: "user-1",
          environmentId: "env-3",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        }),
      );
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(isLimitExceeded(outcome.failure)).toBe(true);
      }
    }).pipe(Effect.provide(h.providerLayer));
  });

  it.effect("reconcileOrigin reports ready vs recovery_required accurately", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const provisioned = yield* provider.provision({
        userId: "user-1",
        environmentId: "env-1",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });
      const tunnelId = provisioned.runtime.tunnelId!;

      expect(
        yield* provider.reconcileOrigin({
          userId: "user-1",
          environmentId: "env-1",
          tunnelId,
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
          endpoint: provisioned.endpoint,
        }),
      ).toBe("ready");

      expect(
        yield* provider.reconcileOrigin({
          userId: "user-1",
          environmentId: "env-1",
          tunnelId: "wrong-tunnel-id",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
          endpoint: provisioned.endpoint,
        }),
      ).toBe("recovery_required");

      expect(
        yield* provider.release({
          userId: "user-1",
          environmentId: "env-1",
          expectedTunnelId: tunnelId,
        }),
      ).toBe(true);

      expect(
        yield* provider.reconcileOrigin({
          userId: "user-1",
          environmentId: "env-1",
          tunnelId,
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
          endpoint: provisioned.endpoint,
        }),
      ).toBe("recovery_required");
    }).pipe(Effect.provide(h.providerLayer));
  });

  it.effect("deprovision removes allocation and stays idempotent when missing", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      yield* provider.provision({
        userId: "user-1",
        environmentId: "env-1",
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      });
      expect(h.getAllocation()).not.toBeNull();

      expect(
        yield* provider.deprovision({
          userId: "user-1",
          environmentId: "env-1",
        }),
      ).toBe(true);
      expect(h.getAllocation()).toBeNull();

      expect(
        yield* provider.deprovision({
          userId: "user-1",
          environmentId: "env-1",
        }),
      ).toBe(true);
    }).pipe(Effect.provide(h.providerLayer));
  });
});
