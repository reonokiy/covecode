import type { EnvironmentTunnelDial } from "@t3tools/client-runtime/relay";
import { browserWire, peerHttpClient } from "@covecode/libp2p-tunnel/http-client";

export async function openDesktopPeer(input: EnvironmentTunnelDial) {
  const {
    openEnvironmentTunnel,
    closeEnvironmentTunnel,
    updateEnvironmentTunnel,
    exchangeEnvironmentFrame: exchange,
  } = window.desktopBridge!;
  if (!openEnvironmentTunnel || !closeEnvironmentTunnel || !updateEnvironmentTunnel || !exchange)
    throw new Error("Desktop tunnel is unavailable");
  const tunnel = await openEnvironmentTunnel({ ...input, lanDiscovery: !!input.discoveryBaseUrl });
  let nextStream = 0;
  let closed = false;
  return {
    ...peerHttpClient(async (signal) => {
      signal.throwIfAborted();
      if (closed) throw new Error("Desktop tunnel closed");
      const stream = String(++nextStream);
      await exchange({ tunnel, stream, action: "open" });
      const lifetime = new AbortController();
      const close = async () => {
        if (lifetime.signal.aborted) return;
        lifetime.abort();
        if (!closed) await exchange({ tunnel, stream, action: "close" });
      };
      if (signal.aborted) {
        await close();
        signal.throwIfAborted();
      }
      return browserWire({
        signal: lifetime.signal,
        close,
        abort: () => {
          void close().catch(() => {});
        },
        async read() {
          if (closed) throw new Error("Desktop tunnel closed");
          const reply = await exchange({ tunnel, stream, action: "read" });
          if (!reply) throw new Error("Desktop stream closed");
          return reply;
        },
        async write(type, data = new Uint8Array()) {
          if (closed) throw new Error("Desktop tunnel closed");
          await exchange({ tunnel, stream, action: { type, data } });
        },
      });
    }),
    updateAddresses: ({ direct, relays }: EnvironmentTunnelDial) =>
      updateEnvironmentTunnel(tunnel, { direct, relays }),
    async close() {
      if (closed) return;
      closed = true;
      await closeEnvironmentTunnel(tunnel);
    },
  };
}
