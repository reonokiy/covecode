import type { RelayLibp2pNodeOptions } from "@covecode/libp2p-tunnel";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: string;
  readonly environment: ApnsEnvironment;
}

export interface T3ChatSettings {
  readonly baseUrl: string;
  // Shared with T3 Chat: signs link tokens and authenticates relay calls.
  readonly linkSecret: Redacted.Redacted<string>;
}

export interface OidcProviderConfiguration {
  readonly issuer: string;
  readonly jwksUri?: string;
  readonly clientId: string;
  readonly audience?: string;
  readonly scopes: ReadonlyArray<string>;
}

export interface Libp2pGatewayConfiguration {
  readonly enabled: boolean;
  readonly listenMultiaddrs: ReadonlyArray<string>;
  readonly replicaMultiaddrs?: ReadonlyArray<string>;
  readonly announceMultiaddrs: ReadonlyArray<string>;
  readonly keyPath?: string;
  readonly connectionLimits?: NonNullable<RelayLibp2pNodeOptions["connectionLimits"]>;
  readonly tunnelSecret: Redacted.Redacted<string>;
  readonly internalGatewayBaseUrl?: string;
}

export class RelayConfiguration extends Context.Service<
  RelayConfiguration,
  {
    readonly relayIssuer: string;
    readonly oidc: OidcProviderConfiguration | null;
    readonly libp2p: Libp2pGatewayConfiguration;
    readonly apns: ApnsCredentials | null;
    readonly fcmServiceAccount?: Redacted.Redacted<string>;
    readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
    readonly cloudMintPrivateKey: Redacted.Redacted<string>;
    readonly cloudMintPublicKey: string;
    readonly managedEndpointBaseDomain: string | undefined;
    readonly managedEndpointNamespace: string | undefined;
    readonly defaultMaxManagedTunnels?: number;
    readonly t3Chat?: T3ChatSettings;
  }
>()("cove-cp/Config/RelayConfiguration") {}

export const layer = (configuration: RelayConfiguration["Service"]) =>
  Layer.succeed(RelayConfiguration, RelayConfiguration.of(configuration));
