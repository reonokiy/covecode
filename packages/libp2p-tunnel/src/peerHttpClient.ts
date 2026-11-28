import { chunkSize, frame, type BrowserWire } from "./browserProtocol.ts";
export { browserWire } from "./browserProtocol.ts";
import { PeerWebSocket } from "./browserSocket.ts";

export function peerHttpClient(openWire: (signal: AbortSignal) => Promise<BrowserWire>) {
  return {
    async fetch(
      request: Request,
      onUploadProgress?: (bytesSent: number) => void,
    ): Promise<Response> {
      const wire = await openWire(request.signal);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const stopUpload = () => {
        void reader?.cancel().catch(() => {});
      };
      const abort = () => {
        stopUpload();
        wire.abort(new Error("Request cancelled"));
      };
      const close = () => {
        stopUpload();
        return wire.close();
      };
      if (request.signal.aborted) {
        abort();
        request.signal.throwIfAborted();
      }
      request.signal.addEventListener("abort", abort, { once: true });
      wire.signal.addEventListener(
        "abort",
        () => {
          stopUpload();
          request.signal.removeEventListener("abort", abort);
        },
        {
          once: true,
        },
      );
      try {
        const url = new URL(request.url);
        await wire.json({
          method: request.method,
          path: url.pathname + url.search,
          headers: [...request.headers],
        });
        const upload = async () => {
          if (request.body) {
            reader = request.body.getReader();
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
              reader = undefined;
            }
          }
          await wire.write(frame.end);
        };
        const head = wire.readJson();
        // An environment can reject an upload before the request body ends.
        const uploading = upload().catch((error) => {
          if (!wire.signal.aborted)
            wire.abort(error instanceof Error ? error : new Error("Upload failed"));
          throw error;
        });
        const metadata = await Promise.race([head, uploading.then(() => head)]);
        if (
          !metadata ||
          typeof metadata !== "object" ||
          !("status" in metadata) ||
          typeof metadata.status !== "number" ||
          !("headers" in metadata) ||
          !Array.isArray(metadata.headers)
        )
          throw new Error("Invalid tunnel response");
        if (metadata.status >= 400) stopUpload();
        const noBody = request.method === "HEAD" || [204, 205, 304].includes(metadata.status);
        const body = noBody
          ? null
          : new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const message = await wire.read();
                  if (message.type === frame.end) {
                    controller.close();
                    await close();
                  } else if (message.type === frame.data) controller.enqueue(message.data);
                  else throw new Error("Invalid response body frame");
                } catch (error) {
                  abort();
                  controller.error(error);
                }
              },
              cancel: abort,
            });
        if (noBody) await close();
        return new Response(body, { status: metadata.status, headers: metadata.headers });
      } catch (error) {
        abort();
        throw error;
      }
    },
    socket: (url: URL, protocols?: string | string[]) =>
      new PeerWebSocket(url, openWire, protocols),
  };
}
