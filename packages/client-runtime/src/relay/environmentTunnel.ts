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

type LiveTunnel = OpenEnvironmentTunnel & {
  readonly updateAddresses: (input: EnvironmentTunnelDial) => void | Promise<void>;
};

export function createEnvironmentTunnels(platform: {
  readonly verifyPeer: (environmentId: string, peerId: string) => Promise<void>;
  readonly open: (input: EnvironmentTunnelDial) => Promise<LiveTunnel>;
}) {
  interface Session {
    requested: EnvironmentTunnelDial;
    applied: EnvironmentTunnelDial;
    pending: Promise<LiveTunnel>;
    updates?: Promise<LiveTunnel>;
  }
  const active = new Map<string, Session>();
  const sameList = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((entry, index) => entry === b[index]);
  const sameAddresses = (a: EnvironmentTunnelDial, b: EnvironmentTunnelDial) =>
    a.discoveryBaseUrl === b.discoveryBaseUrl &&
    sameList(a.direct, b.direct) &&
    sameList(a.relays, b.relays);

  function release(id: string) {
    const session = active.get(id);
    active.delete(id);
    void session?.pending.then(
      (tunnel) => tunnel.close(),
      () => {},
    );
  }

  function open(id: string, input: EnvironmentTunnelDial, verify?: () => Promise<void>) {
    const current = active.get(id);
    if (current?.requested.peerId === input.peerId) {
      current.requested = input;
      if (current.updates) return current.updates;
      if (sameAddresses(current.applied, input)) return current.pending;
      const pending = current.pending.then(async (tunnel) => {
        try {
          while (active.get(id) === current) {
            const latest = current.requested;
            if (sameAddresses(current.applied, latest)) return tunnel;
            try {
              await tunnel.updateAddresses(latest);
            } catch (error) {
              if (!sameAddresses(latest, current.requested)) continue;
              throw error;
            }
            current.applied = latest;
          }
          throw new Error("Tunnel connection changed");
        } finally {
          delete current.updates;
        }
      });
      current.updates = pending;
      return pending;
    }
    release(id);
    const connect = async (): Promise<LiveTunnel> => {
      await verify?.();
      while (active.get(id) === session) {
        const latest = session.requested;
        let tunnel: LiveTunnel;
        try {
          tunnel = await platform.open(latest);
        } catch (error) {
          if (!sameAddresses(latest, session.requested)) continue;
          throw error;
        }
        if (active.get(id) === session) {
          session.applied = latest;
          return tunnel;
        }
        tunnel.close();
      }
      throw new Error("Tunnel connection changed");
    };
    const session: Session = {
      requested: input,
      applied: input,
      pending: Promise.resolve()
        .then(connect)
        .catch((error) => {
          if (active.get(id) === session) active.delete(id);
          throw error;
        }),
    };
    active.set(id, session);
    return session.pending;
  }
  return {
    lan: LanPeerTransport.of({
      openPairing: (peer) => platform.open({ ...peer, relays: [] }),
      prepare: (peer) => open("lan:" + peer.peerId, { ...peer, relays: [] }),
      release: (peerId) => release("lan:" + peerId),
    }),
    prepare(environmentId: string, endpoint: RelayManagedEndpoint): Promise<OpenEnvironmentTunnel> {
      const key = "managed:" + environmentId;
      const current = active.get(key);
      if (
        endpoint.providerKind !== "libp2p_tunnel" ||
        !endpoint.libp2pPeerId ||
        (!endpoint.libp2pRelayMultiaddrs?.length &&
          !endpoint.libp2pDirectMultiaddrs?.length &&
          current?.requested.peerId !== endpoint.libp2pPeerId)
      ) {
        release(key);
        return Promise.reject(new Error("The environment has no authenticated tunnel endpoint"));
      }
      const input: EnvironmentTunnelDial = {
        peerId: endpoint.libp2pPeerId,
        direct: endpoint.libp2pDirectMultiaddrs ?? [],
        relays: endpoint.libp2pRelayMultiaddrs ?? [],
      };
      return open(key, input, () => platform.verifyPeer(environmentId, input.peerId));
    },
    clear() {
      for (const id of active.keys()) if (id.startsWith("managed:")) release(id);
    },
  };
}
