import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";
import type { Connection, Stream } from "@libp2p/interface";
import { pipeStreamAndSocket, streamToNodeDuplex } from "./protocols.ts";

export type EnvironmentHttpTarget =
  | { readonly server: NodeHttp.Server }
  | { readonly localHost: string; readonly localPort: number };

export function environmentHttpIngress(target: EnvironmentHttpTarget) {
  if (!("server" in target)) {
    const connect = () => NodeNet.connect(target.localPort, target.localHost);
    return { connect, accept: (stream: Stream) => pipeStreamAndSocket(stream, connect()) };
  }

  // TCP admission belongs to the listening server. Both ingresses dispatch to its live HTTP handlers.
  const app = target.server;
  const ingress = NodeHttp.createServer((req, res) => app.emit("request", req, res));
  ingress.on("upgrade", (req, socket, head) => {
    if (!app.emit("upgrade", req, socket, head)) socket.destroy();
  });
  function acceptSocket(socket: NodeStream.Duplex, connection: Connection) {
    const address = connection.remoteAddr.getComponents()[0];
    const remoteAddress =
      connection.direct && (address?.name === "ip4" || address?.name === "ip6")
        ? address.value
        : undefined;
    if (remoteAddress) Object.assign(socket, { remoteAddress });
    ingress.emit("connection", socket);
  }
  return {
    accept: (stream: Stream, connection: Connection) =>
      acceptSocket(streamToNodeDuplex(stream), connection),
    connect(connection: Connection) {
      const [client, server] = NodeStream.duplexPair();
      client.once("close", () => server.destroy());
      server.once("close", () => client.destroy());
      acceptSocket(server, connection);
      return client;
    },
  };
}
