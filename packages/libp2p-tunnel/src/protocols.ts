import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import { keys } from "@libp2p/crypto";
import type { PrivateKey, Stream, StreamCloseEvent, StreamMessageEvent } from "@libp2p/interface";

export const COVE_TUNNEL_PROTOCOL = "/cove/http-tunnel/1.0.0";
export const COVE_TUNNEL_REGISTER_PROTOCOL = "/cove/tunnel-register/1.0.0";

export type TunnelTransportMode = "p2p" | "relay";

const ALLOWED_LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function isAllowedLoopbackHost(host: string): boolean {
  return ALLOWED_LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export async function loadOrCreateLibp2pPrivateKey(keyPath?: string): Promise<PrivateKey> {
  if (keyPath !== undefined) {
    try {
      const existing = await NodeFSP.readFile(keyPath);
      return keys.privateKeyFromProtobuf(existing);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  const privateKey = await keys.generateKeyPair("Ed25519");
  if (keyPath !== undefined) {
    await NodeFSP.mkdir(NodePath.dirname(keyPath), { recursive: true });
    await NodeFSP.writeFile(keyPath, keys.privateKeyToProtobuf(privateKey), { mode: 0o600 });
  }
  return privateKey;
}

/**
 * Node.js Duplex adapter over a libp2p v3 MessageStream (`Stream`), including
 * socket-like compatibility methods so `node:http` and WebSocket handlers can
 * operate on it directly via `createConnection` or `.pipe()`.
 */
export class Libp2pStreamDuplex extends NodeStream.Duplex {
  readonly remoteAddress = "127.0.0.1";
  readonly remoteFamily = "IPv4";
  readonly remotePort = 0;
  readonly localAddress = "127.0.0.1";
  readonly localPort = 0;

  private readonly p2pStream: Stream;
  private eofPushed = false;
  private listenersDetached = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly onMessage = (evt: StreamMessageEvent): void => {
    const data = evt.data;
    const raw = data instanceof Uint8Array ? data : data.subarray();
    if (raw.byteLength === 0 || this.eofPushed || this.destroyed) {
      return;
    }
    this.resetIdleTimer();
    const copy = Buffer.from(raw);
    if (!this.push(copy)) {
      this.p2pStream.pause();
    }
  };

  private readonly onEnd = (): void => {
    this.pushEofOnce();
  };

  private readonly onClose = (evt: StreamCloseEvent): void => {
    this.detachListeners();
    if (evt.error && !this.destroyed) {
      this.destroy(evt.error);
      return;
    }
    this.pushEofOnce();
    if (!this.destroyed && !this.readableLength && this.writableFinished) {
      this.destroy();
    }
  };

  private idleTimeoutMs = 0;
  private idleCallback: (() => void) | undefined;

  constructor(stream: Stream, options?: NodeStream.DuplexOptions) {
    super({ allowHalfOpen: true, ...options });
    this.p2pStream = stream;
    stream.addEventListener("message", this.onMessage);
    stream.addEventListener("end", this.onEnd);
    stream.addEventListener("close", this.onClose);

    if (stream.readableEnded || stream.readStatus === "closed") {
      queueMicrotask(() => {
        this.pushEofOnce();
      });
    }
  }

  setTimeout(msecs: number, callback?: () => void): this {
    this.clearIdleTimer();
    this.idleTimeoutMs = Number.isFinite(msecs) && msecs > 0 ? msecs : 0;
    this.idleCallback = callback;
    this.resetIdleTimer();
    return this;
  }

  setNoDelay(_noDelay?: boolean): this {
    return this;
  }

  setKeepAlive(_enable?: boolean, _initialDelay?: number): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  override _read(_size: number): void {
    if (!this.eofPushed && this.p2pStream.readStatus !== "closed") {
      this.p2pStream.resume();
    }
  }

  override _write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes =
      chunk instanceof Uint8Array
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk, encoding)
          : null;
    if (bytes === null) {
      callback(new TypeError("Expected Uint8Array or string chunk"));
      return;
    }
    if (bytes.byteLength === 0) {
      callback();
      return;
    }
    if (this.p2pStream.writeStatus !== "writable" || this.p2pStream.status !== "open") {
      callback(
        new Error(
          `libp2p stream is not writable (status=${this.p2pStream.status}, writeStatus=${this.p2pStream.writeStatus})`,
        ),
      );
      return;
    }

    this.resetIdleTimer();
    try {
      const accepted = this.p2pStream.send(bytes);
      if (accepted) {
        callback();
        return;
      }
      void this.p2pStream.onDrain().then(
        () => callback(),
        (error) => callback(toError(error)),
      );
    } catch (error) {
      callback(toError(error));
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.clearIdleTimer();
    if (this.p2pStream.writeStatus !== "writable") {
      callback();
      return;
    }
    void this.p2pStream.close().then(
      () => callback(),
      (error) => callback(toError(error)),
    );
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.clearIdleTimer();
    this.detachListeners();
    if (error !== null) {
      this.p2pStream.abort(error);
    } else if (this.p2pStream.writeStatus === "writable") {
      void this.p2pStream.close().catch(() => {});
    }
    callback(error);
  }

  private pushEofOnce(): void {
    if (!this.eofPushed) {
      this.eofPushed = true;
      this.push(null);
    }
  }

  private detachListeners(): void {
    if (this.listenersDetached) return;
    this.listenersDetached = true;
    this.p2pStream.removeEventListener("message", this.onMessage);
    this.p2pStream.removeEventListener("end", this.onEnd);
    this.p2pStream.removeEventListener("close", this.onClose);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    if (this.idleTimeoutMs <= 0 || this.destroyed) return;
    this.idleTimer = setTimeout(() => {
      this.idleCallback?.();
      this.emit("timeout");
    }, this.idleTimeoutMs);
  }
}

export function streamToNodeDuplex(
  stream: Stream,
  options?: NodeStream.DuplexOptions,
): Libp2pStreamDuplex {
  return new Libp2pStreamDuplex(stream, options);
}

export function pipeStreamAndSocket(stream: Stream, socket: NodeStream.Duplex): void {
  const duplex = streamToNodeDuplex(stream);

  const cleanup = (error?: Error) => {
    if (error !== undefined) {
      if (!duplex.destroyed) duplex.destroy(error);
      if (!socket.destroyed) socket.destroy(error);
      return;
    }
    if (!duplex.destroyed) duplex.destroy();
    if (!socket.destroyed) socket.destroy();
  };

  duplex.on("error", cleanup);
  socket.on("error", cleanup);
  duplex.on("close", () => {
    if (!socket.destroyed && socket.writableEnded && socket.readableEnded) {
      socket.destroy();
    }
  });
  socket.on("close", () => {
    if (!duplex.destroyed) {
      duplex.destroy();
    }
  });

  duplex.pipe(socket);
  socket.pipe(duplex);
}

export async function writeJsonLine(stream: Stream, payload: unknown): Promise<void> {
  const encoded = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  if (!stream.send(encoded)) {
    await stream.onDrain();
  }
  await stream.close();
}

export async function readBoundedJsonLine<T>(
  stream: Stream,
  maxBytes = 16_384,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      finishError(new Error(`Timed out reading tunnel control message after ${timeoutMs}ms`));
    }, timeoutMs);

    const detach = () => {
      clearTimeout(timer);
      stream.removeEventListener("message", onMessage);
      stream.removeEventListener("end", onEnd);
      stream.removeEventListener("close", onClose);
    };

    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      detach();
      reject(error);
    };

    const finishDecode = () => {
      if (settled) return;
      settled = true;
      detach();
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      const firstLine = raw.split(/\r?\n/u, 1)[0] ?? "";
      if (firstLine.length === 0) {
        reject(new Error("Empty tunnel control message"));
        return;
      }
      try {
        resolve(JSON.parse(firstLine) as T);
      } catch (error) {
        reject(new Error(`Invalid tunnel control JSON: ${toError(error).message}`));
      }
    };

    const onMessage = (evt: StreamMessageEvent) => {
      if (settled) return;
      const bytes = evt.data instanceof Uint8Array ? evt.data : evt.data.subarray();
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        const error = new Error(`Tunnel control message exceeded ${maxBytes} bytes`);
        stream.abort(error);
        finishError(error);
        return;
      }
      const copy = Buffer.from(bytes);
      chunks.push(copy);
      if (copy.includes(0x0a)) {
        finishDecode();
      }
    };

    const onEnd = () => {
      finishDecode();
    };

    const onClose = (evt: StreamCloseEvent) => {
      if (evt.error) {
        finishError(evt.error);
        return;
      }
      finishDecode();
    };

    stream.addEventListener("message", onMessage);
    stream.addEventListener("end", onEnd);
    stream.addEventListener("close", onClose);

    if (stream.readableEnded || stream.readStatus === "closed") {
      finishDecode();
    } else {
      stream.resume();
    }
  });
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
