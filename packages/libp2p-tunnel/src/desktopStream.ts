import { browserWire, type TunnelFrame } from "./browserProtocol.ts";
import { serveBrowserWire } from "./browserBridge.ts";
import { streamToNodeDuplex } from "./protocols.ts";
import type { openEnvironmentPeer } from "./environmentPeer.ts";

export { openEnvironmentPeer } from "./environmentPeer.ts";

// Each IPC read supplies one unit of backpressure to the HTTP response or WebSocket.
export function openDesktopStream(peer: Awaited<ReturnType<typeof openEnvironmentPeer>>) {
  const incoming = new TransformStream<TunnelFrame, TunnelFrame>();
  const outgoing = new TransformStream<TunnelFrame, TunnelFrame>();
  const toHost = incoming.writable.getWriter();
  const fromClient = incoming.readable.getReader();
  const toClient = outgoing.writable.getWriter();
  const fromHost = outgoing.readable.getReader();
  const lifetime = new AbortController();

  function dispose(error = new Error("Desktop stream closed")) {
    if (lifetime.signal.aborted) return;
    lifetime.abort(error);
    void fromClient.cancel(error).catch(() => {});
    void fromHost.cancel(error).catch(() => {});
  }

  const wire = browserWire({
    signal: lifetime.signal,
    async read() {
      const result = await fromClient.read();
      if (result.done) throw new Error("Desktop stream closed");
      return result.value;
    },
    write: (type, data = new Uint8Array()) => toClient.write({ type, data }),
    close: () => toClient.close(),
    abort: dispose,
  });
  let transport: "direct" | "relay" | undefined;
  void serveBrowserWire(
    wire,
    async () =>
      streamToNodeDuplex(
        await peer.openStream(lifetime.signal, (selected) => {
          transport = selected;
        }),
      ),
    undefined,
    () => transport,
  );
  return {
    async read() {
      const result = await fromHost.read();
      return result.done ? null : result.value;
    },
    write: (message: TunnelFrame) => toHost.write(message),
    dispose,
  };
}
