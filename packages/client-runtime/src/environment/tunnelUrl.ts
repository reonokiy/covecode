import { browserTunnelHost, peerResourceUrl } from "./transport.ts";

// The prefix authenticates the local transport. The environment receives and verifies the remaining path.
export function tunnelResourceUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (browserTunnelHost.test(url.hostname)) {
    url.hostname = "cove.invalid";
    url.protocol = url.protocol === "wss:" ? "ws:" : "http:";
    return url;
  }
  if (url.hostname !== "127.0.0.1") return null;
  const prefix = /^\/\.cove-tunnel\/[a-f0-9]{32}(?=\/|$)/u.exec(url.pathname);
  if (!prefix) return null;
  url.pathname = url.pathname.slice(prefix[0].length);
  return url;
}

export function resolveTunnelResource(base: string, path: string): string | null {
  if (!tunnelResourceUrl(base) || !path.startsWith("/") || path.startsWith("//")) return null;
  const url = new URL(base);
  if (path.startsWith("/api/assets/")) {
    const resource = peerResourceUrl(url.hostname, path);
    if (resource) return resource;
  }
  return url.href.replace(/\/$/u, "") + path;
}
