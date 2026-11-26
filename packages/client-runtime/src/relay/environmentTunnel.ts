import type { LanPeer } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";

export interface EnvironmentTunnelDial {
  readonly discoveryBaseUrl?: string;
  readonly peerId: string;
  readonly direct: readonly string[];
  readonly relays: readonly string[];
}

export interface OpenEnvironmentTunnel {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly close: () => void;
}

export class LanPeerTransport extends Context.Service<
  LanPeerTransport,
  {
    readonly openPairing: (
      peer: LanPeer & { readonly discoveryBaseUrl: string },
    ) => Promise<OpenEnvironmentTunnel>;
    readonly prepare: (
      peer: LanPeer & { readonly discoveryBaseUrl: string },
    ) => Promise<OpenEnvironmentTunnel>;
    readonly release: (peerId: string) => void;
  }
>()("@t3tools/client-runtime/relay/environmentTunnel/LanPeerTransport") {}

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
  function open(environmentId: string, input: EnvironmentTunnelDial, verify?: () => Promise<void>) {
    const key = JSON.stringify(input);
    const current = active.get(environmentId);
    if (current?.key === key) return current.pending;
    if (current) close(current.pending);
    function isCurrent() {
      return active.get(environmentId)?.pending === pending;
    }
    const pending: Promise<OpenEnvironmentTunnel> = Promise.resolve()
      .then(async () => {
        await verify?.();
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
  }
  return {
    lan: LanPeerTransport.of({
      openPairing: (peer) => platform.open({ ...peer, relays: [] }),
      prepare: (peer) => open("lan:" + peer.peerId, { ...peer, relays: [] }),
      release(peerId) {
        const key = "lan:" + peerId;
        const current = active.get(key);
        active.delete(key);
        if (current) close(current.pending);
      },
    }),
    prepare(environmentId: string, endpoint: RelayManagedEndpoint): Promise<OpenEnvironmentTunnel> {
      if (
        endpoint.providerKind !== "libp2p_tunnel" ||
        !endpoint.libp2pPeerId ||
        (!endpoint.libp2pRelayMultiaddrs?.length && !endpoint.libp2pDirectMultiaddrs?.length)
      ) {
        return Promise.reject(new Error("The environment has no authenticated tunnel endpoint"));
      }
      const input: EnvironmentTunnelDial = {
        peerId: endpoint.libp2pPeerId,
        direct: endpoint.libp2pDirectMultiaddrs ?? [],
        relays: endpoint.libp2pRelayMultiaddrs ?? [],
      };
      return open("managed:" + environmentId, input, () =>
        platform.verifyPeer(environmentId, input.peerId),
      );
    },
    clear() {
      for (const [id, entry] of active) {
        if (id.startsWith("managed:")) {
          active.delete(id);
          close(entry.pending);
        }
      }
    },
  };
}
