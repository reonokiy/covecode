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
    const proxies = new Map<string, () => Promise<void>>();
    let stopped = false;
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        stopped = true;
        await Promise.allSettled(Array.from(proxies.values(), (close) => close()));
        proxies.clear();
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: Channels.OPEN_ENVIRONMENT_TUNNEL_CHANNEL,
        payload: Schema.Struct({
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
              const { createClientLibp2pProxy } = await import("@covecode/libp2p-tunnel/proxy");
              const proxy = await createClientLibp2pProxy({
                targetPeerId: input.peerId,
                directMultiaddrs: input.direct,
                relayMultiaddrs: input.relays,
              });
              try {
                await proxy.connect();
                if (
                  stopped ||
                  owner.isDestroyed() ||
                  document.detached ||
                  document !== owner.mainFrame
                )
                  throw new Error("Desktop tunnel stopped");
                const release = async () => {
                  if (!proxies.delete(proxy.httpBaseUrl)) return;
                  owner.off("did-navigate", released);
                  owner.off("render-process-gone", released);
                  owner.off("destroyed", released);
                  await proxy.stop();
                };
                const released = () => {
                  void release().catch(() => {});
                };
                proxies.set(proxy.httpBaseUrl, release);
                owner.once("did-navigate", released);
                owner.once("render-process-gone", released);
                owner.once("destroyed", released);
                return proxy.httpBaseUrl;
              } catch (error) {
                await proxy.stop();
                throw error;
              }
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
        handler: (url) =>
          Effect.tryPromise({
            try: async () => {
              await proxies.get(url)?.();
            },
            catch: (cause) => new DesktopTunnelError({ cause }),
          }),
      }),
    );
  },
);
