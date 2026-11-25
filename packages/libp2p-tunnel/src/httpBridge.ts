import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import type { Stream } from "@libp2p/interface";

import { pipeStreamAndSocket, streamToNodeDuplex } from "./protocols.ts";

export interface HttpProxyOptions {
  readonly stripPathPrefix?: string;
  readonly onError?: (error: Error) => void;
}

export function rewriteRequestTargetPath(
  rawUrl: string | undefined,
  stripPathPrefix?: string,
): string {
  const input = rawUrl && rawUrl.length > 0 ? rawUrl : "/";
  const queryIndex = input.indexOf("?");
  const pathname = queryIndex >= 0 ? input.slice(0, queryIndex) : input;
  const search = queryIndex >= 0 ? input.slice(queryIndex) : "";

  if (!stripPathPrefix) {
    return `${pathname.startsWith("/") ? pathname : `/${pathname}`}${search}`;
  }

  const normalizedPrefix = stripPathPrefix.replace(/\/+$/gu, "");
  if (normalizedPrefix.length === 0 || normalizedPrefix === "/") {
    return `${pathname.startsWith("/") ? pathname : `/${pathname}`}${search}`;
  }

  if (pathname === normalizedPrefix) {
    return `/${search}`;
  }

  if (pathname.startsWith(`${normalizedPrefix}/`)) {
    const rest = pathname.slice(normalizedPrefix.length);
    return `${rest.length > 0 ? rest : "/"}${search}`;
  }

  return `${pathname.startsWith("/") ? pathname : `/${pathname}`}${search}`;
}

function buildProxiedHeaders(headers: NodeHttp.IncomingHttpHeaders): NodeHttp.OutgoingHttpHeaders {
  const next: NodeHttp.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (
      lower === "connection" ||
      lower === "proxy-connection" ||
      lower === "keep-alive" ||
      lower === "transfer-encoding"
    ) {
      continue;
    }
    next[key] = value;
  }
  next.connection = "close";
  return next;
}

export async function proxyHttpRequestOverStream(options: {
  readonly stream: Stream;
  readonly req: NodeHttp.IncomingMessage;
  readonly res: NodeHttp.ServerResponse;
  readonly stripPathPrefix?: string;
  readonly onError?: (error: Error) => void;
}): Promise<void> {
  const { stream, req, res } = options;
  const targetPath = rewriteRequestTargetPath(req.url, options.stripPathPrefix);
  const duplex = streamToNodeDuplex(stream);

  return new Promise<void>((resolve) => {
    let settled = false;
    const agent = new NodeHttp.Agent({ keepAlive: false });
    agent.createConnection = () => duplex as unknown as NodeNet.Socket;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error !== undefined) {
        options.onError?.(error);
        if (!res.headersSent && !res.writableEnded) {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "tunnel_upstream_failed", message: error.message }));
        } else if (!res.destroyed) {
          res.destroy(error);
        }
      }
      if (!duplex.destroyed) {
        duplex.destroy();
      }
      agent.destroy();
      resolve();
    };

    const proxyReq = NodeHttp.request({
      method: req.method ?? "GET",
      path: targetPath,
      headers: buildProxiedHeaders(req.headers),
      agent,
    });

    proxyReq.on("response", (proxyRes) => {
      if (settled) return;
      res.statusCode = proxyRes.statusCode ?? 502;
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (value === undefined) continue;
        const lower = key.toLowerCase();
        if (lower === "transfer-encoding" || lower === "connection" || lower === "keep-alive") {
          continue;
        }
        res.setHeader(key, value);
      }

      proxyRes.on("error", (error) => finish(error));
      res.on("error", (error) => finish(error));
      res.on("finish", () => finish());
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (error) => {
      finish(error);
    });

    req.on("aborted", () => {
      proxyReq.destroy();
      finish();
    });

    req.on("error", (error) => {
      proxyReq.destroy(error);
      finish(error);
    });

    if (req.method === "GET" || req.method === "HEAD") {
      proxyReq.end();
      return;
    }

    req.pipe(proxyReq);
  });
}

export async function proxyUpgradeOverStream(options: {
  readonly stream: Stream;
  readonly req: NodeHttp.IncomingMessage;
  readonly socket: NodeStream.Duplex;
  readonly head: Buffer;
  readonly stripPathPrefix?: string;
}): Promise<void> {
  const { stream, req, socket, head } = options;
  const targetPath = rewriteRequestTargetPath(req.url, options.stripPathPrefix);

  const lines: string[] = [`${req.method ?? "GET"} ${targetPath} HTTP/${req.httpVersion || "1.1"}`];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    if (name === undefined || value === undefined) continue;
    lines.push(`${name}: ${value}`);
  }
  lines.push("", "");

  const headerBytes = Buffer.from(lines.join("\r\n"), "latin1");
  const initialPayload = head.byteLength > 0 ? Buffer.concat([headerBytes, head]) : headerBytes;

  if (!stream.send(initialPayload)) {
    await stream.onDrain();
  }

  pipeStreamAndSocket(stream, socket);
}

export function writeUpgradeErrorResponse(
  socket: NodeStream.Duplex,
  statusCode = 502,
  reason = "Bad Gateway",
): void {
  if (socket.destroyed || !socket.writable) return;
  socket.write(
    `HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}
