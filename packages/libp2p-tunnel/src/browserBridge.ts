import type * as NodeStream from "node:stream";
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import { WebSocket, createWebSocketStream } from "ws";
import type { Stream } from "@libp2p/interface";
import {
  type BrowserWire,
  chunkSize,
  closePayload,
  readClosePayload,
  frame,
  framedStream,
  requestHead,
  textBytes,
} from "./browserProtocol.ts";

export async function serveBrowserStream(stream: Stream, connect: () => NodeStream.Duplex) {
  return serveBrowserWire(framedStream(stream), connect, 16 * 1024 * 1024);
}

export async function serveBrowserWire(
  wire: BrowserWire,
  connect: () => NodeStream.Duplex | Promise<NodeStream.Duplex>,
  maxPayload?: number,
  selectedTransport?: () => "direct" | "relay" | undefined,
) {
  let target: NodeStream.Duplex | undefined;
  try {
    const head = requestHead(await wire.readJson());
    const headers = Object.fromEntries(head.headers);
    for (const name of Object.keys(headers)) {
      if (
        /^(host$|cookie$|proxy-|forwarded$|x-forwarded-|connection$|upgrade$|transfer-encoding$|content-length$|sec-websocket-)/u.test(
          name,
        )
      )
        delete headers[name];
    }
    headers["accept-encoding"] = "identity";
    headers.host = "cove.invalid";
    const socketStream = await connect();
    target = socketStream;
    wire.signal.throwIfAborted();
    const createConnection = () => socketStream;
    if (head.method === "WS") {
      const socket = new WebSocket(`ws://cove.invalid${head.path}`, head.protocols, {
        headers,
        createConnection,
        ...(maxPayload !== undefined ? { maxPayload } : {}),
      });
      // Object mode preserves text frames and lets Node pause reads on libp2p backpressure.
      const duplex = createWebSocketStream(socket, { readableObjectMode: true });
      const closed = new Promise<Uint8Array>((resolve) =>
        socket.once("close", (code, reason) => resolve(closePayload(code, reason.toString()))),
      );
      duplex.on("error", () => socket.terminate());
      const abort = () => socket.terminate();
      wire.signal.addEventListener("abort", abort, { once: true });
      try {
        await NodeEvents.EventEmitter.once(socket, "open");
        await wire.json({
          status: 101,
          protocol: socket.protocol,
          transport: selectedTransport?.(),
        });
        const send = async () => {
          for await (const data of duplex) {
            await wire.write(
              typeof data === "string" ? frame.text : frame.data,
              typeof data === "string" ? textBytes(data) : data,
            );
          }
          await wire.write(frame.close, await closed);
        };
        const outbound = send();
        const receive = async () => {
          while (true) {
            const message = await wire.read();
            if (message.type === frame.close) {
              const { code, reason } = readClosePayload(message.data);
              socket.close(code, reason);
              return outbound;
            }
            if (message.type !== frame.data && message.type !== frame.text)
              throw new Error("Invalid socket frame");
            await new Promise<void>((resolve, reject) =>
              socket.send(message.data, { binary: message.type === frame.data }, (error) =>
                error ? reject(error) : resolve(),
              ),
            );
          }
        };
        await Promise.race([outbound, receive()]);
      } finally {
        wire.signal.removeEventListener("abort", abort);
        duplex.destroy();
        socket.terminate();
      }
    } else {
      headers.connection = "close";
      const req = NodeHttp.request({
        host: "cove.invalid",
        createConnection,
        method: head.method,
        path: head.path,
        headers,
        setHost: false,
      });
      const abort = () => req.destroy();
      wire.signal.addEventListener("abort", abort, { once: true });
      const response = NodeEvents.EventEmitter.once(req, "response").then(async ([response]) => {
        const res: NodeHttp.IncomingMessage = response;
        const pairs: string[][] = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          const name = res.rawHeaders[i]!;
          if (!/^(set-cookie|connection|transfer-encoding|content-length)$/iu.test(name))
            pairs.push([name, res.rawHeaders[i + 1]!]);
        }
        await wire.json({ status: res.statusCode, headers: pairs });
        for await (const buf of res) {
          for (let i = 0; i < buf.length; i += chunkSize)
            await wire.write(frame.data, buf.subarray(i, i + chunkSize));
        }
        await wire.write(frame.end);
      });
      try {
        req.flushHeaders();
        const upload = async () => {
          while (true) {
            const message = await wire.read();
            if (message.type === frame.end) {
              req.end();
              return;
            }
            if (message.type !== frame.data || message.data.length > chunkSize)
              throw new Error("Invalid request body frame");
            if (!req.write(message.data)) await NodeEvents.EventEmitter.once(req, "drain");
          }
        };
        await Promise.race([response, upload().then(() => response)]);
      } finally {
        wire.signal.removeEventListener("abort", abort);
        req.destroy();
      }
    }
    await wire.close();
  } catch (error) {
    wire.abort(error instanceof Error ? error : new Error("Browser tunnel failed"));
  } finally {
    target?.destroy();
  }
}
