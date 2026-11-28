import type { Stream } from "@libp2p/interface";
import { lpStream } from "@libp2p/utils";

export const BROWSER_TUNNEL_PROTOCOL = "/cove/browser-tunnel/1.0.0";
const utf8 = new TextEncoder();
const decoder = new TextDecoder();
export const chunkSize = 64 * 1024;
export const textBytes = (value: string) => utf8.encode(value);
export const bytesText = (value: Uint8Array) => decoder.decode(value);
export const frame = { open: 0, data: 1, text: 2, end: 3, close: 4 } as const;

export function closePayload(code: number, reason: string) {
  const text = textBytes(reason);
  if (text.length > 123) throw new RangeError("WebSocket close reason is too long");
  const bytes = new Uint8Array(text.length + 2);
  new DataView(bytes.buffer).setUint16(0, code);
  bytes.set(text, 2);
  return bytes;
}

export function readClosePayload(data: Uint8Array) {
  if (data.length < 2 || data.length > 125) throw new Error("Invalid WebSocket close frame");
  return { code: (data[0]! << 8) | data[1]!, reason: bytesText(data.subarray(2)) };
}

export interface TunnelFrame {
  readonly type: number;
  readonly data: Uint8Array;
}

export interface FrameChannel {
  readonly transport?: "direct" | "relay";
  readonly read: () => Promise<TunnelFrame>;
  readonly write: (type: number, data?: Uint8Array) => Promise<void>;
  readonly signal: AbortSignal;
  readonly close: () => Promise<void>;
  readonly abort: (error: Error) => void;
}

export function browserWire(channel: FrameChannel) {
  return {
    ...channel,
    json(value: unknown) {
      return this.write(frame.open, textBytes(JSON.stringify(value)));
    },
    async readJson(): Promise<unknown> {
      const { type, data } = await this.read();
      if (type !== frame.open || data.length > chunkSize) throw new Error("Invalid tunnel headers");
      return JSON.parse(bytesText(data));
    },
  };
}

export function framedStream(stream: Stream) {
  const wire = lpStream(stream, {
    maxDataLength: 16 * 1024 * 1024 + 1,
    maxBufferSize: 32 * 1024 * 1024,
  });
  const closed = new AbortController();
  stream.addEventListener("close", () => closed.abort(), { once: true });
  return browserWire({
    signal: closed.signal,
    close: () => stream.close(),
    abort: (error) => stream.abort(error),
    async read() {
      const message = await wire.read();
      if (!message.byteLength) throw new Error("Empty tunnel frame");
      return { type: message.get(0), data: message.subarray(1) };
    },
    write(type: number, data = new Uint8Array(0) as Uint8Array) {
      const message = new Uint8Array(data.byteLength + 1);
      message[0] = type;
      message.set(data, 1);
      return wire.write(message);
    },
  });
}

export type BrowserWire = ReturnType<typeof browserWire>;
export function requestHead(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("method" in value) ||
    typeof value.method !== "string" ||
    !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|WS)$/u.test(value.method) ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    !/^\/(?!\/)/u.test(value.path) ||
    /[\x00-\x20\\]/u.test(value.path) ||
    !("headers" in value) ||
    !Array.isArray(value.headers)
  )
    throw new Error("Invalid browser tunnel request");
  const headers = new Headers();
  for (const entry of value.headers) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    )
      throw new Error("Invalid tunnel header");
    headers.append(entry[0], entry[1]);
  }
  const protocols = "protocols" in value ? value.protocols : [];
  if (
    !Array.isArray(protocols) ||
    !protocols.every((protocol): protocol is string => typeof protocol === "string")
  )
    throw new Error("Invalid WebSocket protocols");
  return { method: value.method, path: value.path, headers, protocols };
}
