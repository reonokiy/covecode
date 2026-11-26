import { isSecureOidcEndpoint } from "@t3tools/shared/oidc";
import { RelayControlPlanePublicConfig } from "@t3tools/contracts/relay";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownSync(RelayControlPlanePublicConfig);

export const controlPlaneSessionKey = (origin: string) =>
  "cove.oidc.session." + Hex.encode(new TextEncoder().encode(origin));

export async function discoverControlPlane(value: string, request: typeof globalThis.fetch) {
  const origin = normalizeSecureRelayUrl(value);
  if (!origin) throw new Error("Invalid control panel address");
  const response = await request(new URL("/.well-known/cove-control-plane", origin), {
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Control panel discovery failed");
  const config = decode(await response.json());
  if (normalizeSecureRelayUrl(config.controlPlaneUrl) !== origin || !config.oidc) {
    throw new Error("Control panel sign-in is unavailable");
  }
  const issuer = new URL(config.oidc.issuer);
  if (!isSecureOidcEndpoint(issuer.href) || issuer.search)
    throw new Error("Invalid sign-in issuer");
  return { origin, oidc: config.oidc, libp2p: config.libp2p };
}
