import { DpopProof, ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import * as Layer from "effect/Layer";

import { environmentTunnels } from "./environmentTunnel";
import { loadOrCreateProofKey } from "./dpop";

const layerRelayDpopSigner = DpopProof.layerSigner({
  keyStore: "indexed-db",
  loadOrCreateKey: loadOrCreateProofKey(),
});

export const layer = (relayUrl: string) =>
  ManagedRelay.layer({ relayUrl, clientId: RelayWebClientId, tunnels: environmentTunnels }).pipe(
    Layer.provideMerge(layerRelayDpopSigner),
  );
