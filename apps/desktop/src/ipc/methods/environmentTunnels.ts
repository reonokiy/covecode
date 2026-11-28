import {
  DesktopTunnelOperation,
  DesktopTunnelFrame,
  DesktopTunnelAddresses,
} from "@t3tools/contracts";
import type { openDesktopStream, openEnvironmentPeer } from "@covecode/libp2p-tunnel/desktop";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

class DesktopTunnelError extends Schema.TaggedError<DesktopTunnelError>()("DesktopTunnelError", {
  cause: Schema.Defect(),
}) {}

export const installEnvironmentTunnels = Effect.fn("desktop.ipc.installEnvironmentTunnels")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    const tunnels = new Map<
      string,
      {
        owner: number;
        open: () => ReturnType<typeof openDesktopStream>;
        updateAddresses: (addresses: typeof DesktopTunnelAddresses.Type) => void;
        streams: Map<string, ReturnType<typeof openDesktopStream>>;
        close: () => Promise<void>;
      }
    >();
    let nextTunnel = 0;
    let stopped = false;
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        stopped = true;
        await Promise.allSettled(Array.from(tunnels.values(), (tunnel) => tunnel.close()));
        tunnels.clear();
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: Channels.OPEN_ENVIRONMENT_TUNNEL_CHANNEL,
        payload: Schema.Struct({
          lanDiscovery: Schema.optional(Schema.Boolean),
          peerId: Schema.String,
          relays: Schema.Array(Schema.String),
          direct: Schema.Array(Schema.String),
        }),
        result: Schema.String,
        handler: (input, event) =>
          Effect.tryPromise({
            try: async () => {
              const owner = event && Electron.webContents.fromId(event.sender.id);
              if (!owner || owner.isDestroyed()) throw new Error("Desktop window closed");
              const document = owner.mainFrame;
              const id = String(++nextTunnel);
              const streams = new Map<string, ReturnType<typeof openDesktopStream>>();
              let peer: Awaited<ReturnType<typeof openEnvironmentPeer>> | undefined;
              let closed = false;
              const release = async () => {
                if (closed) return;
                closed = true;
                tunnels.delete(id);
                for (const stream of streams.values()) stream.dispose();
                streams.clear();
                owner.off("did-navigate", released);
                owner.off("render-process-gone", released);
                owner.off("destroyed", released);
                await peer?.stop();
              };
              const released = () => {
                void release().catch(() => {});
              };
              owner.once("did-navigate", released);
              owner.once("render-process-gone", released);
              owner.once("destroyed", released);
              try {
                const transport = await import("@covecode/libp2p-tunnel/desktop");
                if (closed || stopped) throw new Error("Desktop tunnel stopped");
                const opened = await transport.openEnvironmentPeer({
                  ...(input.lanDiscovery !== undefined ? { lanDiscovery: input.lanDiscovery } : {}),
                  targetPeerId: input.peerId,
                  directMultiaddrs: input.direct,
                  relayMultiaddrs: input.relays,
                });
                if (closed) {
                  await opened.stop();
                  throw new Error("Desktop tunnel stopped");
                }
                peer = opened;
                tunnels.set(id, {
                  owner: owner.id,
                  updateAddresses: opened.updateAddresses,
                  streams,
                  open: () => transport.openDesktopStream(opened),
                  close: release,
                });
                if (!stopped) await peer.connect();
                if (
                  closed ||
                  stopped ||
                  owner.isDestroyed() ||
                  document.detached ||
                  document !== owner.mainFrame
                )
                  throw new Error("Desktop tunnel stopped");
                return id;
              } catch (error) {
                await release();
                throw error;
              }
            },
            catch: (cause) => new DesktopTunnelError({ cause }),
          }),
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: Channels.ENVIRONMENT_TUNNEL_FRAME_CHANNEL,
        payload: DesktopTunnelOperation,
        result: Schema.NullOr(DesktopTunnelFrame),
        handler: ({ tunnel: id, stream: key, action }, event) =>
          Effect.tryPromise({
            try: async () => {
              const tunnel = tunnels.get(id);
              if (!tunnel || tunnel.owner !== event?.sender.id) {
                if (action === "close" || action === "read") return null;
                throw new Error("Desktop tunnel closed");
              }
              const stream = tunnel.streams.get(key);
              if (action === "open") {
                if (stream || tunnel.streams.size >= 256)
                  throw new Error("Desktop stream limit reached");
                tunnel.streams.set(key, tunnel.open());
              } else if (action === "close") {
                tunnel.streams.delete(key);
                stream?.dispose();
              } else {
                if (action === "read") return stream?.read() ?? null;
                if (!stream) throw new Error("Desktop stream closed");
                await stream.write(action);
              }
              return null;
            },
            catch: (cause) => new DesktopTunnelError({ cause }),
          }),
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: Channels.UPDATE_ENVIRONMENT_TUNNEL_CHANNEL,
        payload: Schema.Struct({ id: Schema.String, addresses: DesktopTunnelAddresses }),
        result: Schema.Void,
        handler: ({ id, addresses }, event) =>
          Effect.try({
            try: () => {
              const tunnel = tunnels.get(id);
              if (!tunnel || tunnel.owner !== event?.sender.id)
                throw new Error("Desktop tunnel closed");
              tunnel.updateAddresses(addresses);
            },
            catch: (cause) => new DesktopTunnelError({ cause }),
          }),
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: Channels.CLOSE_ENVIRONMENT_TUNNEL_CHANNEL,
        payload: Schema.String,
        result: Schema.Void,
        handler: (id, event) =>
          Effect.tryPromise({
            try: async () => {
              const tunnel = tunnels.get(id);
              if (tunnel && tunnel.owner === event?.sender.id) await tunnel.close();
            },
            catch: (cause) => new DesktopTunnelError({ cause }),
          }),
      }),
    );
  },
);
