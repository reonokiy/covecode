import { isAllowedLoopbackHost } from "@covecode/libp2p-tunnel";
import type {
  RelayManagedEndpoint,
  RelayManagedEndpointOrigin,
  RelayManagedEndpointRuntimeConfig,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";
import {
  DEFAULT_MANAGED_ENDPOINT_NAMESPACE,
  managedEndpointDigestInput,
  managedEndpointTunnelName,
  managedEndpointUrls,
} from "../deploymentConfig.ts";
import { deriveTunnelConnectorToken } from "./Libp2pTunnelRegistry.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

export class ManagedEndpointProvisioningNotConfigured extends Schema.TaggedError<ManagedEndpointProvisioningNotConfigured>()(
  "ManagedEndpointProvisioningNotConfigured",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    missingSettings: Schema.Array(Schema.Literals(["relayIssuer", "libp2pTunnelSecret"])),
  },
) {
  override get message(): string {
    return `Managed endpoint provisioning is not configured for user '${this.userId}', environment '${this.environmentId}': missing ${this.missingSettings.join(", ")}`;
  }
}

const ManagedEndpointProvisioningStage = Schema.Literals([
  "derive-environment-hash",
  "check-tunnel-limit",
  "reserve-allocation",
  "record-tunnel",
  "mark-allocation-ready",
  "load-allocation",
]);

export class ManagedEndpointProvisioningFailed extends Schema.TaggedError<ManagedEndpointProvisioningFailed>()(
  "ManagedEndpointProvisioningFailed",
  {
    stage: ManagedEndpointProvisioningStage,
    userId: Schema.String,
    environmentId: Schema.String,
    hostname: Schema.optionalKey(Schema.String),
    tunnelName: Schema.optionalKey(Schema.String),
    tunnelId: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Managed endpoint provisioning failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

const ManagedEndpointDeprovisioningStage = Schema.Literals([
  "load-allocation",
  "claim-release",
  "claim-deprovision",
  "remove-allocation",
]);

export class ManagedEndpointDeprovisioningFailed extends Schema.TaggedError<ManagedEndpointDeprovisioningFailed>()(
  "ManagedEndpointDeprovisioningFailed",
  {
    stage: ManagedEndpointDeprovisioningStage,
    userId: Schema.String,
    environmentId: Schema.String,
    tunnelId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed endpoint deprovisioning failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class ManagedEndpointOriginNotAllowed extends Schema.TaggedError<ManagedEndpointOriginNotAllowed>()(
  "ManagedEndpointOriginNotAllowed",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    host: Schema.String,
    port: Schema.Number,
  },
) {
  override get message(): string {
    return `Managed endpoint origin '${this.host}:${this.port}' is not allowed for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export type ManagedEndpointProviderError =
  | ManagedEndpointProvisioningNotConfigured
  | ManagedEndpointProvisioningFailed
  | ManagedEndpointOriginNotAllowed
  | ManagedTunnelLimits.ManagedTunnelLimitExceeded;

export interface ManagedEndpointProvisioningResult {
  readonly endpoint: RelayManagedEndpoint;
  readonly runtime: RelayManagedEndpointRuntimeConfig;
}

export type ManagedEndpointOriginSyncResult = "ready" | "recovery_required";

export type ManagedEndpointDeprovisionTarget = ManagedEndpointAllocations.ManagedEndpointAllocation;

export class ManagedEndpointProvider extends Context.Service<
  ManagedEndpointProvider,
  {
    readonly provision: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly origin: RelayManagedEndpointOrigin;
      readonly reuseReadyTunnel?: boolean;
    }) => Effect.Effect<ManagedEndpointProvisioningResult, ManagedEndpointProviderError>;
    readonly reconcileOrigin: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly tunnelId: string;
      readonly origin: RelayManagedEndpointOrigin;
      readonly endpoint: RelayManagedEndpoint;
    }) => Effect.Effect<ManagedEndpointOriginSyncResult, ManagedEndpointProviderError>;
    readonly prepareDeprovision: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<
      ManagedEndpointDeprovisionTarget | null,
      ManagedEndpointDeprovisioningFailed
    >;
    readonly deprovision: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly target?: ManagedEndpointDeprovisionTarget | null;
    }) => Effect.Effect<boolean, ManagedEndpointDeprovisioningFailed>;
    readonly release: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly expectedTunnelId?: string;
      readonly expectedInactiveBefore?: string;
      readonly expectedStatus?: "inactive" | "down";
      readonly markReleased?: boolean;
    }) => Effect.Effect<boolean, ManagedEndpointDeprovisioningFailed>;
  }
>()("cove-cp/environments/ManagedEndpointProvider") {}

function validateOrigin(userId: string, environmentId: string, origin: RelayManagedEndpointOrigin) {
  const isValidPort =
    Number.isInteger(origin.localHttpPort) &&
    origin.localHttpPort >= 1 &&
    origin.localHttpPort <= 65_535;
  if (!isAllowedLoopbackHost(origin.localHttpHost) || !isValidPort) {
    return Effect.fail(
      new ManagedEndpointOriginNotAllowed({
        userId,
        environmentId,
        host: origin.localHttpHost,
        port: origin.localHttpPort,
      }),
    );
  }
  return Effect.void;
}

const make = Effect.gen(function* () {
  const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
  const tunnelLimits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
  const settings = yield* RelayConfiguration.RelayConfiguration;
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;

  const namespace = settings.managedEndpointNamespace ?? DEFAULT_MANAGED_ENDPOINT_NAMESPACE;

  const failProvisioning = (input: {
    readonly stage: typeof ManagedEndpointProvisioningStage.Type;
    readonly userId: string;
    readonly environmentId: string;
    readonly hostname?: string;
    readonly tunnelName?: string;
    readonly tunnelId?: string;
    readonly cause?: unknown;
  }) =>
    new ManagedEndpointProvisioningFailed({
      stage: input.stage,
      userId: input.userId,
      environmentId: input.environmentId,
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
      ...(input.tunnelName !== undefined ? { tunnelName: input.tunnelName } : {}),
      ...(input.tunnelId !== undefined ? { tunnelId: input.tunnelId } : {}),
      ...(input.cause !== undefined ? { cause: input.cause } : {}),
    });

  const deriveEndpointHash = (input: { readonly userId: string; readonly environmentId: string }) =>
    digest
      .digest(
        Digest.sha256,
        new TextEncoder().encode(
          managedEndpointDigestInput(namespace, input.userId, input.environmentId),
        ),
      )
      .pipe(
        Effect.map((bytes) => Hex.encode(bytes).slice(0, 16)),
        Effect.mapError((cause) =>
          failProvisioning({
            stage: "derive-environment-hash",
            userId: input.userId,
            environmentId: input.environmentId,
            cause,
          }),
        ),
      );

  const buildProvisioningResult = (input: {
    readonly endpointKey: string;
    readonly tunnelId: string;
    readonly tunnelName: string;
    readonly environmentId: string;
  }): ManagedEndpointProvisioningResult => {
    const urls = managedEndpointUrls({
      relayIssuer: settings.relayIssuer,
      endpointKey: input.endpointKey,
      baseDomain: settings.managedEndpointBaseDomain,
    });
    const connectorToken = deriveTunnelConnectorToken(
      Redacted.value(settings.libp2p.tunnelSecret),
      {
        endpointKey: input.endpointKey,
        tunnelId: input.tunnelId,
        environmentId: input.environmentId,
      },
    );
    const advertised = settings.libp2p.replicaMultiaddrs ?? settings.libp2p.announceMultiaddrs;
    const relayMultiaddrs = advertised.length ? [...advertised] : undefined;

    return {
      endpoint: {
        httpBaseUrl: urls.httpBaseUrl,
        wsBaseUrl: urls.wsBaseUrl,
        providerKind: "libp2p_tunnel",
        ...(relayMultiaddrs !== undefined ? { libp2pRelayMultiaddrs: relayMultiaddrs } : {}),
        transportMode: "p2p",
      },
      runtime: {
        providerKind: "libp2p_tunnel",
        connectorToken,
        tunnelId: input.tunnelId,
        tunnelName: input.tunnelName,
        endpointKey: input.endpointKey,
        publicHttpBaseUrl: urls.httpBaseUrl,
        ...(relayMultiaddrs !== undefined ? { relayMultiaddrs } : {}),
        transportMode: "p2p",
      },
    };
  };

  return ManagedEndpointProvider.of({
    provision: Effect.fn("relay.managed_endpoint_provider.provision")(function* (input) {
      yield* validateOrigin(input.userId, input.environmentId, input.origin);

      const endpointKey = yield* deriveEndpointHash(input);
      const urls = managedEndpointUrls({
        relayIssuer: settings.relayIssuer,
        endpointKey,
        baseDomain: settings.managedEndpointBaseDomain,
      });
      const tunnelName = managedEndpointTunnelName(namespace, endpointKey);

      const allocation = yield* tunnelLimits
        .withCapacity(
          {
            userId: input.userId,
            environmentId: input.environmentId,
          },
          allocations
            .reserve({
              userId: input.userId,
              environmentId: input.environmentId,
              hostname: urls.hostname,
              tunnelName,
            })
            .pipe(
              Effect.mapError((cause) =>
                failProvisioning({
                  stage: "reserve-allocation",
                  userId: input.userId,
                  environmentId: input.environmentId,
                  hostname: urls.hostname,
                  tunnelName,
                  cause,
                }),
              ),
            ),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ManagedTunnelLimitExceeded" ||
            error._tag === "ManagedEndpointProvisioningFailed"
              ? error
              : failProvisioning({
                  stage: "check-tunnel-limit",
                  userId: input.userId,
                  environmentId: input.environmentId,
                  hostname: urls.hostname,
                  tunnelName,
                  cause: error,
                }),
          ),
        );

      const tunnelId =
        allocation.tunnelId ??
        `libp2p-${yield* random.uuidV4().pipe(
          Effect.mapError((cause) =>
            failProvisioning({
              stage: "record-tunnel",
              userId: input.userId,
              environmentId: input.environmentId,
              hostname: urls.hostname,
              tunnelName,
              cause,
            }),
          ),
        )}`;

      let generation = allocation.generation;
      if (allocation.tunnelId === null || allocation.tunnelReleasedAt !== null) {
        const nextGeneration = yield* allocations
          .recordTunnel({
            userId: input.userId,
            environmentId: input.environmentId,
            tunnelId,
            generation,
          })
          .pipe(
            Effect.mapError((cause) =>
              failProvisioning({
                stage: "record-tunnel",
                userId: input.userId,
                environmentId: input.environmentId,
                hostname: urls.hostname,
                tunnelName,
                tunnelId,
                cause,
              }),
            ),
          );
        if (nextGeneration === null) {
          return yield* failProvisioning({
            stage: "record-tunnel",
            userId: input.userId,
            environmentId: input.environmentId,
            hostname: urls.hostname,
            tunnelName,
            tunnelId,
            cause: "allocation-generation-mismatch",
          });
        }
        generation = nextGeneration;
      }

      if (allocation.dnsRecordId !== "libp2p") {
        const dnsGeneration = yield* allocations
          .recordDns({
            userId: input.userId,
            environmentId: input.environmentId,
            tunnelId,
            dnsRecordId: "libp2p",
            generation,
          })
          .pipe(
            Effect.mapError((cause) =>
              failProvisioning({
                stage: "mark-allocation-ready",
                userId: input.userId,
                environmentId: input.environmentId,
                hostname: urls.hostname,
                tunnelName,
                tunnelId,
                cause,
              }),
            ),
          );
        if (dnsGeneration === null) {
          return yield* failProvisioning({
            stage: "mark-allocation-ready",
            userId: input.userId,
            environmentId: input.environmentId,
            hostname: urls.hostname,
            tunnelName,
            tunnelId,
            cause: "dns-generation-mismatch",
          });
        }
        generation = dnsGeneration;
      }

      const ready = yield* allocations
        .markReady({
          userId: input.userId,
          environmentId: input.environmentId,
          tunnelId,
          generation,
          origin: input.origin,
        })
        .pipe(
          Effect.mapError((cause) =>
            failProvisioning({
              stage: "mark-allocation-ready",
              userId: input.userId,
              environmentId: input.environmentId,
              hostname: urls.hostname,
              tunnelName,
              tunnelId,
              cause,
            }),
          ),
        );
      if (!ready) {
        return yield* failProvisioning({
          stage: "mark-allocation-ready",
          userId: input.userId,
          environmentId: input.environmentId,
          hostname: urls.hostname,
          tunnelName,
          tunnelId,
          cause: "mark-ready-conflict",
        });
      }

      return buildProvisioningResult({
        endpointKey,
        tunnelId,
        tunnelName,
        environmentId: input.environmentId,
      });
    }),
    reconcileOrigin: Effect.fn("relay.managed_endpoint_provider.reconcile_origin")(
      function* (input) {
        yield* validateOrigin(input.userId, input.environmentId, input.origin);
        const allocation = yield* allocations.get(input).pipe(
          Effect.mapError((cause) =>
            failProvisioning({
              stage: "load-allocation",
              userId: input.userId,
              environmentId: input.environmentId,
              tunnelId: input.tunnelId,
              cause,
            }),
          ),
        );
        if (
          allocation === null ||
          allocation.tunnelId !== input.tunnelId ||
          allocation.tunnelReleasedAt !== null ||
          allocation.readyAt === null
        ) {
          return "recovery_required" as const;
        }
        return "ready" as const;
      },
    ),
    prepareDeprovision: Effect.fn("relay.managed_endpoint_provider.prepare_deprovision")(
      function* (input) {
        return yield* allocations.get(input).pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointDeprovisioningFailed({
                stage: "load-allocation",
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
      },
    ),
    deprovision: Effect.fn("relay.managed_endpoint_provider.deprovision")(function* (input) {
      const target =
        input.target !== undefined
          ? input.target
          : yield* allocations.get(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointDeprovisioningFailed({
                    stage: "load-allocation",
                    userId: input.userId,
                    environmentId: input.environmentId,
                    cause,
                  }),
              ),
            );
      if (target === null) {
        return true;
      }

      const claimedGeneration = yield* allocations
        .claimDeprovision({
          userId: input.userId,
          environmentId: input.environmentId,
          generation: target.generation,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointDeprovisioningFailed({
                stage: "claim-deprovision",
                userId: input.userId,
                environmentId: input.environmentId,
                ...(target.tunnelId !== null ? { tunnelId: target.tunnelId } : {}),
                cause,
              }),
          ),
        );
      if (claimedGeneration === null) {
        return false;
      }

      return yield* allocations
        .removeClaimed({
          userId: input.userId,
          environmentId: input.environmentId,
          generation: claimedGeneration,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointDeprovisioningFailed({
                stage: "remove-allocation",
                userId: input.userId,
                environmentId: input.environmentId,
                ...(target.tunnelId !== null ? { tunnelId: target.tunnelId } : {}),
                cause,
              }),
          ),
        );
    }),
    release: Effect.fn("relay.managed_endpoint_provider.release")(function* (input) {
      const allocation = yield* allocations.get(input).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointDeprovisioningFailed({
              stage: "load-allocation",
              userId: input.userId,
              environmentId: input.environmentId,
              ...(input.expectedTunnelId !== undefined ? { tunnelId: input.expectedTunnelId } : {}),
              cause,
            }),
        ),
      );
      if (
        allocation === null ||
        allocation.tunnelId === null ||
        (input.expectedTunnelId !== undefined && allocation.tunnelId !== input.expectedTunnelId)
      ) {
        return false;
      }

      const tunnelId = allocation.tunnelId;
      const nextGeneration = yield* allocations
        .claimRelease({
          userId: input.userId,
          environmentId: input.environmentId,
          tunnelId,
          generation: allocation.generation,
          markReleased: input.markReleased !== false,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointDeprovisioningFailed({
                stage: "claim-release",
                userId: input.userId,
                environmentId: input.environmentId,
                tunnelId,
                cause,
              }),
          ),
        );
      return nextGeneration !== null;
    }),
  });
});

export const layer = Layer.effect(ManagedEndpointProvider, make);
