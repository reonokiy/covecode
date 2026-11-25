import * as Redacted from "effect/Redacted";

import type * as RelayConfiguration from "./Config.ts";

export function makeTestRelayConfiguration(
  overrides: Partial<RelayConfiguration.RelayConfiguration["Service"]> = {},
): RelayConfiguration.RelayConfiguration["Service"] {
  return {
    relayIssuer: "https://relay.example.test",
    oidc: {
      issuer: "https://auth.example.test",
      clientId: "t3-code-test",
      scopes: ["openid", "profile", "email"],
    },
    libp2p: {
      enabled: false,
      listenMultiaddrs: [],
      announceMultiaddrs: [],
      tunnelSecret: Redacted.make("test-libp2p-tunnel-secret"),
    },
    apns: {
      environment: "sandbox",
      teamId: "team-id",
      keyId: "key-id",
      privateKey: Redacted.make("private-key"),
      bundleId: "net.nokiy.cove.dev",
    },
    apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
    cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
    cloudMintPublicKey: "cloud-mint-public-key",
    managedEndpointBaseDomain: undefined,
    managedEndpointNamespace: undefined,
    ...overrides,
  };
}
