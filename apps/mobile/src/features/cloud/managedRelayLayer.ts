import { DpopProof, ManagedRelay, LanPeerTransport } from "@t3tools/client-runtime/relay";
import { RelayMobileClientId } from "@t3tools/contracts/relay";
import * as Layer from "effect/Layer";

import { environmentTunnels } from "./environmentTunnel";
import { loadOrCreateProofKey } from "./dpop";
import { managedRelayAccessTokenStore } from "./managedRelayTokenStore";

const layerRelayDpopSigner = DpopProof.layerSigner({
  keyStore: "expo-secure-store",
  loadOrCreateKey: loadOrCreateProofKey(),
});

export const layer = (relayUrl: string) =>
  ManagedRelay.layer({
    relayUrl,
    tunnels: environmentTunnels,
    clientId: RelayMobileClientId,
    accessTokenStore: managedRelayAccessTokenStore,
  }).pipe(
    Layer.provideMerge(
      Layer.merge(layerRelayDpopSigner, Layer.succeed(LanPeerTransport, environmentTunnels.lan)),
    ),
  );
