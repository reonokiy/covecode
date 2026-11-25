import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";
import { normalizeRelayIssuer } from "@t3tools/shared/relayJwt";

const DNS_LABEL_MAX_LENGTH = 63;
const MANAGED_ENDPOINT_HASH_LENGTH = 16;
const MANAGED_ENDPOINT_TUNNEL_PREFIX = "cove-managedendpoint";
export const MANAGED_ENDPOINT_PATH_PREFIX = "/t/";
export const DEFAULT_MANAGED_ENDPOINT_NAMESPACE = "selfhosted";

function normalizeZoneName(zoneName: string): string {
  return zoneName
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/gu, "");
}

function isDnsName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 253 &&
    name
      .split(".")
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= DNS_LABEL_MAX_LENGTH &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  );
}

function stableSuffix(hash: string): string {
  return hash.toLowerCase().slice(0, MANAGED_ENDPOINT_HASH_LENGTH);
}

function appendDnsSafeSuffix(prefix: string, suffix: string): string {
  const truncatedPrefix = prefix
    .slice(0, DNS_LABEL_MAX_LENGTH - suffix.length - 1)
    .replace(/-+$/gu, "");
  return `${truncatedPrefix}-${suffix}`;
}

function namespaceSlug(namespace: string): string {
  return namespace
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export function managedEndpointDigestInput(
  namespace: string,
  userId: string,
  environmentId: string,
): string {
  return `${namespace}:${userId}:${environmentId}`;
}

export function managedEndpointHostname(
  namespace: string,
  baseDomain: string,
  hash: string,
): string {
  const label = appendDnsSafeSuffix(namespaceSlug(namespace), stableSuffix(hash));
  return `${label}.${normalizeZoneName(baseDomain)}`;
}

export function isManagedEndpointHostname(hostname: string, baseDomain: string): boolean {
  const normalizedHostname = normalizeZoneName(hostname);
  const normalizedBaseDomain = normalizeZoneName(baseDomain);
  return (
    hostname === normalizedHostname &&
    isDnsName(normalizedHostname) &&
    isDnsName(normalizedBaseDomain) &&
    normalizedHostname.endsWith(`.${normalizedBaseDomain}`)
  );
}

export function managedEndpointForHostname(hostname: string): RelayManagedEndpoint {
  return {
    httpBaseUrl: `https://${hostname}/`,
    wsBaseUrl: `wss://${hostname}/ws`,
    providerKind: "libp2p_tunnel",
  };
}

export function managedEndpointPathKey(endpointKey: string): string {
  return `t/${endpointKey}`;
}

export function isManagedEndpointPathKey(value: string): boolean {
  if (!value.startsWith("t/")) return false;
  return MANAGED_ENDPOINT_KEY_PATTERN.test(value.slice(2));
}

export function extractEndpointKeyFromPath(pathname: string): string | null {
  const pathOnly = pathname.split("?", 1)[0] ?? pathname;
  if (!pathOnly.startsWith(MANAGED_ENDPOINT_PATH_PREFIX)) return null;
  const rest = pathOnly.slice(MANAGED_ENDPOINT_PATH_PREFIX.length);
  const slashIndex = rest.indexOf("/");
  const candidate = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
  return MANAGED_ENDPOINT_KEY_PATTERN.test(candidate) ? candidate : null;
}

export function extractEndpointKeyFromSubdomainHost(
  hostHeader: string | undefined,
  baseDomain: string | undefined,
): string | null {
  if (!hostHeader || !baseDomain) return null;
  const hostname = hostHeader.split(":", 1)[0]?.trim().toLowerCase() ?? "";
  const normalizedBase = normalizeZoneName(baseDomain);
  if (!normalizedBase || !hostname.endsWith(`.${normalizedBase}`)) return null;
  const label = hostname.slice(0, -(normalizedBase.length + 1));
  if (!label || label.includes(".")) return null;
  const tailIndex = label.lastIndexOf("-");
  const candidate = tailIndex === -1 ? label : label.slice(tailIndex + 1);
  return MANAGED_ENDPOINT_KEY_PATTERN.test(candidate) ? candidate : null;
}

export function managedEndpointUrls(input: {
  readonly relayIssuer: string;
  readonly endpointKey: string;
  readonly baseDomain?: string | undefined;
}): {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly hostname: string;
} {
  const key = stableSuffix(input.endpointKey);
  if (input.baseDomain) {
    const cleanDomain = normalizeZoneName(input.baseDomain);
    const hostname = `${key}.${cleanDomain}`;
    return {
      hostname,
      httpBaseUrl: `https://${hostname}/`,
      wsBaseUrl: `wss://${hostname}/ws`,
    };
  }
  const normalizedIssuer = normalizeRelayIssuer(input.relayIssuer);
  const wsIssuer = normalizedIssuer.replace(/^https:/iu, "wss:").replace(/^http:/iu, "ws:");
  return {
    hostname: managedEndpointPathKey(key),
    httpBaseUrl: `${normalizedIssuer}/t/${key}/`,
    wsBaseUrl: `${wsIssuer}/t/${key}/ws`,
  };
}

export function managedEndpointTunnelNamePrefix(namespace: string): string {
  return `${MANAGED_ENDPOINT_TUNNEL_PREFIX}-${namespaceSlug(namespace)}-`;
}

export function managedEndpointTunnelName(namespace: string, hash: string): string {
  return `${managedEndpointTunnelNamePrefix(namespace)}${stableSuffix(hash)}`;
}

/** Tunnel-name hash covers user and environment; public environment ids alone do not identify an authorized link. */
export const MANAGED_ENDPOINT_KEY_PATTERN = new RegExp(
  `^[0-9a-f]{${MANAGED_ENDPOINT_HASH_LENGTH}}$`,
  "u",
);

export function managedEndpointTunnelNameForKey(namespace: string, endpointKey: string): string {
  return `${managedEndpointTunnelNamePrefix(namespace)}${endpointKey}`;
}

export function legacyManagedEndpointTunnelNameForKey(
  namespace: string,
  endpointKey: string,
): string {
  return `t3coderelay-managedendpoint-${namespaceSlug(namespace)}-${endpointKey}`;
}

export function endpointKeyFromTunnelName(namespace: string, tunnelName: string): string | null {
  for (const prefix of [
    managedEndpointTunnelNamePrefix(namespace),
    `t3coderelay-managedendpoint-${namespaceSlug(namespace)}-`,
  ]) {
    if (tunnelName.startsWith(prefix)) {
      const candidate = tunnelName.slice(prefix.length);
      if (MANAGED_ENDPOINT_KEY_PATTERN.test(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
