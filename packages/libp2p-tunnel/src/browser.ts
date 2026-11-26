import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Connection, Stream } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { BROWSER_TUNNEL_PROTOCOL, chunkSize, frame, framedStream } from "./browserProtocol.ts";
import { PeerWebSocket } from "./browserSocket.ts";

export async function openBrowserTunnel(input: {
  peerId: string;
  direct: readonly string[];
  relays: readonly string[];
}) {
  const peer = peerIdFromString(input.peerId);
  const circuit = input.relays
    .filter((addr) => addr.includes("/ws") || addr.includes("/wss"))
    .map((addr) => addr.replace(/\/$/u, "") + "/p2p-circuit");
  if (!circuit.length) throw new Error("No browser-accessible relay address");
  const node = await createLibp2p({
    transports: [webSockets(), webRTC(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
  const direct = [
    ...input.direct.filter(
      (a) => a.endsWith(`/p2p/${peer}`) && /\/(?:wss|ws|webrtc-direct)(?:\/|$)/u.test(a),
    ),
    ...circuit.map((addr) => `${addr}/webrtc/p2p/${peer}`),
  ].map((addr) => multiaddr(addr));
  const relayed = circuit.map((addr) => multiaddr(`${addr}/p2p/${peer}`));
  const lifetime = new AbortController();
  let dialing: Promise<Connection> | undefined;
  let upgrading: Promise<unknown> | undefined;
  let lastAttempt = 0;
  async function tryDirect() {
    lastAttempt = Date.now();
    return node.dial(direct, {
      force: true,
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(3500)]),
    });
  }
  function connect(): Promise<Connection> {
    const connections = node.getConnections(peer).filter((c) => c.status === "open");
    const preferred = connections.find((c) => c.direct);
    if (preferred) return Promise.resolve(preferred);
    if (connections[0]) {
      if (!upgrading && Date.now() - lastAttempt > 30_000)
        upgrading = tryDirect()
          .catch(() => {})
          .finally(() => {
            upgrading = undefined;
          });
      return Promise.resolve(connections[0]);
    }
    dialing ??= tryDirect()
      .catch(() =>
        node.dial(relayed, {
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]),
        }),
      )
      .finally(() => {
        dialing = undefined;
      });
    return dialing;
  }
  try {
    await connect();
  } catch (error) {
    lifetime.abort();
    await node.stop();
    throw error;
  }
  async function openStream(signal?: AbortSignal): Promise<Stream> {
    const conn = await connect();
    if (!conn.remotePeer.equals(peer)) throw new Error("Unexpected environment peer");
    return conn.newStream(BROWSER_TUNNEL_PROTOCOL, {
      runOnLimitedConnection: true,
      signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
    });
  }
  return {
    getActiveTransport: () =>
      node
        .getConnections(peer)
        .some((connection) => connection.status === "open" && connection.direct)
        ? "direct"
        : "relay",
    async fetch(
      request: Request,
      onUploadProgress?: (bytesSent: number) => void,
    ): Promise<Response> {
      const stream = await openStream(request.signal);
      const wire = framedStream(stream);
      const abort = () => stream.abort(new Error("Request cancelled"));
      request.signal.addEventListener("abort", abort, { once: true });
      stream.addEventListener("close", () => request.signal.removeEventListener("abort", abort), {
        once: true,
      });
      try {
        const url = new URL(request.url);
        await wire.json({
          method: request.method,
          path: url.pathname + url.search,
          headers: [...request.headers],
        });
        const upload = async () => {
          if (request.body) {
            const reader = request.body.getReader();
            let sent = 0;
            try {
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                for (let i = 0; i < value.length; i += chunkSize) {
                  const chunk = value.subarray(i, i + chunkSize);
                  await wire.write(frame.data, chunk);
                  sent += chunk.byteLength;
                  onUploadProgress?.(sent);
                }
              }
            } finally {
              reader.releaseLock();
            }
          }
          await wire.write(frame.end);
        };
        const [metadata] = await Promise.all([wire.readJson(), upload()]);
        if (
          !metadata ||
          typeof metadata !== "object" ||
          !("status" in metadata) ||
          typeof metadata.status !== "number" ||
          !("headers" in metadata) ||
          !Array.isArray(metadata.headers)
        )
          throw new Error("Invalid tunnel response");
        const noBody = request.method === "HEAD" || [204, 205, 304].includes(metadata.status);
        const body = noBody
          ? null
          : new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const message = await wire.read();
                  if (message.type === frame.end) {
                    controller.close();
                    await stream.close();
                  } else if (message.type === frame.data) controller.enqueue(message.data);
                  else throw new Error("Invalid response body frame");
                } catch (error) {
                  abort();
                  controller.error(error);
                }
              },
              cancel: abort,
            });
        if (noBody) await stream.close();
        return new Response(body, { status: metadata.status, headers: metadata.headers });
      } catch (error) {
        abort();
        throw error;
      }
    },
    socket: (url: URL, protocols?: string | string[]) =>
      new PeerWebSocket(url, openStream, protocols),
    async close() {
      lifetime.abort();
      await node.stop();
    },
  };
}
