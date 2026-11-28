// @effect-diagnostics globalConsole:off - This standalone WebSocket adapter reports the local connection path in DevTools.
import {
  bytesText,
  closePayload,
  readClosePayload,
  frame,
  textBytes,
  type BrowserWire,
} from "./browserProtocol.ts";

export class PeerWebSocket extends EventTarget implements WebSocket {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState: WebSocket["readyState"] = this.CONNECTING;
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  readonly extensions = "";
  protocol = "";
  transport: "direct" | "relay" | "disconnected" = "disconnected";
  readonly url: string;
  onopen: WebSocket["onopen"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;
  onmessage: WebSocket["onmessage"] = null;
  private readonly lifetime = new AbortController();
  private wire?: BrowserWire;
  private writes = Promise.resolve();

  constructor(
    url: URL,
    open: (signal: AbortSignal) => Promise<BrowserWire>,
    protocols?: string | string[],
  ) {
    super();
    this.url = url.href;
    void this.run(url, open, protocols).catch(() => this.finish(false));
  }

  private async run(
    url: URL,
    open: (signal: AbortSignal) => Promise<BrowserWire>,
    protocols?: string | string[],
  ) {
    const wire = (this.wire = await open(this.lifetime.signal));
    if (this.lifetime.signal.aborted) {
      wire.abort(new Error("Socket closed"));
      return;
    }
    await wire.json({
      method: "WS",
      path: url.pathname + url.search,
      headers: [],
      protocols: typeof protocols === "string" ? [protocols] : (protocols ?? []),
    });
    const reply = await wire.readJson();
    if (!reply || typeof reply !== "object" || !("status" in reply) || reply.status !== 101)
      throw new Error("Socket upgrade failed");
    if ("protocol" in reply && typeof reply.protocol === "string") this.protocol = reply.protocol;
    if (this.readyState !== this.CONNECTING) return;
    this.transport =
      wire.transport ??
      ("transport" in reply && (reply.transport === "direct" || reply.transport === "relay")
        ? reply.transport
        : "disconnected");
    if (url.pathname === "/ws")
      console.info("Cove RPC WebSocket opened", { transport: this.transport });
    this.readyState = this.OPEN;
    const opened = new Event("open");
    this.dispatchEvent(opened);
    this.onopen?.(opened);
    while (!this.lifetime.signal.aborted) {
      const message = await wire.read();
      if (message.type === frame.close) {
        const { code, reason } = readClosePayload(message.data);
        this.finish(code !== 1006, code, reason);
        return;
      }
      if (message.type !== frame.text && message.type !== frame.data)
        throw new Error("Invalid socket frame");
      const bytes = Uint8Array.from(message.data);
      const data =
        message.type === frame.text
          ? bytesText(bytes)
          : this.binaryType === "blob"
            ? new Blob([bytes])
            : bytes.buffer;
      const event = new MessageEvent("message", { data });
      this.dispatchEvent(event);
      this.onmessage?.(event);
    }
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== this.OPEN)
      throw new DOMException("Socket is not open", "InvalidStateError");
    const size =
      typeof data === "string"
        ? textBytes(data).length
        : data instanceof Blob
          ? data.size
          : data.byteLength;
    this.bufferedAmount += size;
    this.writes = this.writes
      .then(async () => {
        const bytes =
          typeof data === "string"
            ? textBytes(data)
            : data instanceof Blob
              ? new Uint8Array(await data.arrayBuffer())
              : ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(data);
        await this.wire?.write(typeof data === "string" ? frame.text : frame.data, bytes);
        this.bufferedAmount -= size;
      })
      .catch(() => this.finish(false));
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= this.CLOSING) return;
    if (code !== 1000 && (code < 3000 || code > 4999))
      throw new DOMException("Invalid WebSocket close code", "InvalidAccessError");
    const data = closePayload(code, reason);
    if (this.readyState === this.CONNECTING) {
      this.finish(false);
      return;
    }
    this.readyState = this.CLOSING;
    void this.writes
      .then(() => this.wire?.write(frame.close, data))
      .catch(() => this.finish(false));
  }

  private finish(clean: boolean, code = clean ? 1000 : 1006, reason = "") {
    if (this.readyState === this.CLOSED) return;
    this.transport = "disconnected";
    this.readyState = this.CLOSED;
    this.lifetime.abort();
    if (clean) void this.wire?.close().catch(() => {});
    else {
      this.wire?.abort(new Error("Environment tunnel closed"));
      const error = new Event("error");
      this.dispatchEvent(error);
      this.onerror?.(error);
    }
    const event = new CloseEvent("close", { code, reason, wasClean: clean });
    this.dispatchEvent(event);
    this.onclose?.(event);
  }
}
