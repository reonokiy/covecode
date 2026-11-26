import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";

export interface EnvironmentTunnelDial {
  readonly peerId: string;
  readonly direct: readonly string[];
  readonly relays: readonly string[];
}

export interface OpenEnvironmentTunnel {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly close: () => void;
}

export function createEnvironmentTunnels(platform: {
  readonly verifyPeer: (environmentId: string, peerId: string) => Promise<void>;
  readonly open: (input: EnvironmentTunnelDial) => Promise<OpenEnvironmentTunnel>;
}) {
  const active = new Map<string, { key: string; pending: Promise<OpenEnvironmentTunnel> }>();
  const close = (pending: Promise<OpenEnvironmentTunnel>) => {
    void pending.then(
      (tunnel) => tunnel.close(),
      () => {},
    );
  };
  return {
    prepare(environmentId: string, endpoint: RelayManagedEndpoint): Promise<OpenEnvironmentTunnel> {
      if (
        endpoint.providerKind !== "libp2p_tunnel" ||
        !endpoint.libp2pPeerId ||
        !endpoint.libp2pRelayMultiaddrs?.length
      ) {
        return Promise.reject(new Error("The environment has no authenticated tunnel endpoint"));
      }
      const input: EnvironmentTunnelDial = {
        peerId: endpoint.libp2pPeerId,
        direct: endpoint.libp2pDirectMultiaddrs ?? [],
        relays: endpoint.libp2pRelayMultiaddrs,
      };
      const key = JSON.stringify(input);
      const current = active.get(environmentId);
      if (current?.key === key) return current.pending;
      if (current) close(current.pending);
      function isCurrent() {
        return active.get(environmentId)?.pending === pending;
      }
      const pending: Promise<OpenEnvironmentTunnel> = Promise.resolve()
        .then(async () => {
          await platform.verifyPeer(environmentId, input.peerId);
          if (!isCurrent()) throw new Error("Tunnel connection changed");
          const tunnel = await platform.open(input);
          if (isCurrent()) return tunnel;
          tunnel.close();
          throw new Error("Tunnel connection changed");
        })
        .catch((error) => {
          if (isCurrent()) active.delete(environmentId);
          throw error;
        });
      active.set(environmentId, { key, pending });
      return pending;
    },
    clear() {
      for (const entry of active.values()) close(entry.pending);
      active.clear();
    },
  };
}
