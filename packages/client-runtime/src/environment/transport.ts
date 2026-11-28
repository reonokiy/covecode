// @effect-diagnostics globalFetch:off - This adapter supplies the platform fetch used by the environment HttpClient.
export const browserTunnelHost = /^[a-f0-9]{32}\.cove\.invalid$/u;

interface EnvironmentPeerTransport {
  fetch(request: Request, onProgress?: (sent: number) => void): Promise<Response>;
  resourceUrl(path: string): string;
  socket(url: URL, protocols?: string | string[]): WebSocket;
}

const peers = new Map<string, EnvironmentPeerTransport>();

export function registerEnvironmentPeer(host: string, peer: EnvironmentPeerTransport) {
  peers.set(host, peer);
  return () => peers.delete(host);
}

export function peerResourceUrl(host: string, path: string) {
  return peers.get(host)?.resourceUrl(path);
}

export function resolveBrowserDownloadUrl(value: string): string {
  if (!peers.size) return value;
  const url = new URL(value, "http://cove.invalid");
  return peerResourceUrl(url.hostname, url.pathname + url.search + url.hash) ?? value;
}

function peerFor(input: RequestInfo | URL) {
  const value = typeof input === "string" ? input : "url" in input ? input.url : input.href;
  let url: URL;
  try {
    url = new URL(value, globalThis.location?.href);
  } catch {
    return null;
  }
  if (!browserTunnelHost.test(url.hostname)) return null;
  const peer = peers.get(url.hostname);
  if (!peer) throw new Error("Environment tunnel closed");
  return { peer, url };
}

export const fetchEnvironment: typeof globalThis.fetch = async (input, init) => {
  const target = peerFor(input);
  return target ? target.peer.fetch(new Request(input, init)) : globalThis.fetch(input, init);
};

export function openEnvironmentSocket(url: string | URL, protocols?: string | string[]) {
  const target = peerFor(url);
  return target ? target.peer.socket(target.url, protocols) : new WebSocket(url, protocols);
}

export async function postEnvironmentFile(
  url: string,
  file: Blob,
  mimeType: string,
  signal: AbortSignal,
  progress: (fraction: number) => void,
): Promise<number> {
  signal.throwIfAborted();
  const target = peerFor(url);
  if (target) {
    const response = await target.peer.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": mimeType },
        body: file,
        signal,
      }),
      (sent) => {
        if (file.size) progress(sent / file.size);
      },
    );
    await response.arrayBuffer();
    return response.status;
  }
  return new Promise<number>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", mimeType);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) progress(event.loaded / event.total);
    });
    xhr.addEventListener("load", () => resolve(xhr.status));
    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.addEventListener("abort", () => reject(signal.reason));
    xhr.addEventListener("loadend", () => signal.removeEventListener("abort", abort));
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}
