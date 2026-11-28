import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import {
  openEnvironmentPeer,
  type ActiveProxyTransport,
  type EnvironmentPeerOptions,
} from "./environmentPeer.ts";
import type { TunnelTransportMode } from "./protocols.ts";

export type { ActiveProxyTransport } from "./environmentPeer.ts";
import {
  proxyHttpRequestOverStream,
  proxyUpgradeOverStream,
  writeUpgradeErrorResponse,
} from "./httpBridge.ts";
export interface ClientLibp2pProxyOptions extends EnvironmentPeerOptions {
  readonly listenHost?: string;
  readonly listenPort?: number;
}

export interface ClientLibp2pProxy {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly peerId: string;
  readonly mode: TunnelTransportMode;
  connect: () => Promise<ActiveProxyTransport>;
  getActiveTransport: () => ActiveProxyTransport;
  stop: () => Promise<void>;
}

export async function createClientLibp2pProxy(
  options: ClientLibp2pProxyOptions,
): Promise<ClientLibp2pProxy> {
  const peer = await openEnvironmentPeer(options);
  const prefix = `/.cove-tunnel/${NodeCrypto.randomUUID().replaceAll("-", "")}`;
  const localSockets = new Set<NodeNet.Socket>();
  const allowed = (req: NodeHttp.IncomingMessage) =>
    req.headers.host === authority && req.url?.startsWith(prefix + "/");
  const server = NodeHttp.createServer((req, res) => {
    if (!allowed(req)) {
      res.writeHead(404).end();
      return;
    }
    void peer
      .openStream()
      .then((stream) =>
        proxyHttpRequestOverStream({
          stream,
          req,
          res,
          stripPathPrefix: prefix,
        }),
      )
      .catch((error) => {
        if (!res.headersSent && !res.writableEnded) {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: "p2p_proxy_unavailable",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      });
  });

  server.on("connection", (socket) => {
    localSockets.add(socket);
    socket.once("close", () => localSockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    if (!allowed(req)) {
      socket.destroy();
      return;
    }
    void peer
      .openStream()
      .then((stream) =>
        proxyUpgradeOverStream({
          stream,
          req,
          socket,
          head,
          stripPathPrefix: prefix,
        }),
      )
      .catch(() => {
        writeUpgradeErrorResponse(socket, 502, "P2P Proxy Unavailable");
      });
  });

  let authority = "";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.listenPort ?? 0, options.listenHost ?? "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  }).catch(async (error) => {
    await peer.stop();
    throw error;
  });

  const address = server.address() as NodeNet.AddressInfo | null;
  if (!address) {
    await peer.stop();
    throw new Error("Failed to bind local P2P proxy HTTP server");
  }

  const host = address.address === "::" ? "127.0.0.1" : address.address;
  authority = `${host}:${address.port}`;
  const httpBaseUrl = `http://${authority}${prefix}`;
  const wsBaseUrl = `ws://${authority}${prefix}`;

  return {
    httpBaseUrl,
    wsBaseUrl,
    ...peer,
    stop: async () => {
      for (const socket of localSockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await peer.stop();
    },
  };
}
