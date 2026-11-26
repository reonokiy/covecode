import type { LanPeer } from "@t3tools/contracts";
import { setPairingTokenOnUrl } from "@t3tools/shared/remote";
import { buildHostedPairingUrl } from "../../hostedPairing";

export type PairingLanPeer = LanPeer;

export function resolveDesktopPairingUrl(
  endpointUrl: string,
  credential: string,
  lanPeer?: PairingLanPeer | null,
): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential, lanPeer).toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}
