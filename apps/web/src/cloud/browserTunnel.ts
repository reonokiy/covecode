import { registerEnvironmentPeer, fetchEnvironment } from "@t3tools/client-runtime/environment";
import { LanPeer } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { randomUUID } from "../lib/utils";
import type { EnvironmentTunnelDial } from "@t3tools/client-runtime/relay";
import type { peerHttpClient } from "@covecode/libp2p-tunnel/http-client";

type EnvironmentPeer = ReturnType<typeof peerHttpClient> & {
  close: () => Promise<void>;
  updateAddresses: (input: EnvironmentTunnelDial) => void | Promise<void>;
};

const assetPaths = new Map<string, Map<string, string>>();
const decodeLanDescriptor = Schema.decodeUnknownSync(Schema.Struct({ lanPeer: LanPeer }));
let handlersInstalled = false;
let installed: Promise<string> | undefined;

function workerClientId(controller: ServiceWorker): Promise<string> {
  const { port1, port2 } = new MessageChannel();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      port1.close();
      reject(new Error("Environment resource worker did not respond"));
    }, 10_000);
    port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      port1.close();
      if (typeof data === "string" && /^[a-zA-Z0-9-]+$/u.test(data)) resolve(data);
      else reject(new Error("Invalid environment resource owner"));
    };
    controller.postMessage({ type: "cove-tunnel-owner" }, [port2]);
  });
}

function install() {
  navigator.serviceWorker?.addEventListener("message", (event) => {
    const message = event.data;
    const port = event.ports[0];
    if (
      event.source !== navigator.serviceWorker.controller ||
      !port ||
      message?.type !== "cove-tunnel-resource"
    )
      return;
    const paths = assetPaths.get(message.host);
    const path = typeof message.asset === "string" ? paths?.get(message.asset) : message.path;
    const fail = () => {
      port.postMessage({ error: true });
      port.close();
    };
    if (
      !paths ||
      typeof path !== "string" ||
      !(
        path.startsWith("/api/assets/") ||
        path.startsWith("/api/device-hub/") ||
        path.startsWith("/api/preview-stream/download?")
      ) ||
      !["GET", "HEAD"].includes(message.method)
    ) {
      fail();
      return;
    }
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    port.onmessage = async ({ data }) => {
      if (data.cancel) {
        abort.abort();
        await reader?.cancel();
        port.close();
      }
      if (data.pull && reader) {
        try {
          const part = await reader.read();
          if (part.done) {
            port.postMessage({ done: true });
            port.close();
          } else {
            const bytes = Uint8Array.from(part.value);
            port.postMessage({ bytes }, [bytes.buffer]);
          }
        } catch {
          fail();
        }
      }
    };
    void fetchEnvironment(
      new Request(`https://${message.host}${path}`, {
        method: message.method,
        headers: message.headers,
        signal: abort.signal,
      }),
    ).then((response) => {
      reader = response.body?.getReader();
      port.postMessage({
        status: response.status,
        headers: [...response.headers],
        body: !!reader,
      });
      if (!reader) port.close();
    }, fail);
  });
}

export async function openWebPeer(
  input: EnvironmentTunnelDial,
  open: (input: EnvironmentTunnelDial) => Promise<EnvironmentPeer> = openBrowserPeer,
) {
  if (!navigator.serviceWorker)
    throw new Error("Encrypted environment access requires a secure Web origin");
  if (!installed) {
    if (!handlersInstalled) {
      install();
      handlersInstalled = true;
    }
    installed = navigator.serviceWorker
      .register("/cove-tunnel-sw.js")
      .then(async () => {
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller)
          await new Promise<void>((resolve) =>
            navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
              once: true,
            }),
          );
        return workerClientId(navigator.serviceWorker.controller!);
      })
      .catch((error) => {
        installed = undefined;
        throw error;
      });
  }
  const owner = await installed;
  const peer = await open(input);
  const host = randomUUID().replaceAll("-", "") + ".cove.invalid";
  const paths = new Map<string, string>();
  const keys = new Map<string, string>();
  assetPaths.set(host, paths);
  const unregister = registerEnvironmentPeer(host, {
    ...peer,
    resourceUrl(resource) {
      const url = new URL(resource, `https://${host}`);
      const path = url.pathname + url.search;
      let key = keys.get(path);
      if (!key) {
        if (paths.size >= 8192) {
          const oldest = paths.keys().next().value!;
          keys.delete(paths.get(oldest)!);
          paths.delete(oldest);
        }
        key = randomUUID();
        keys.set(path, key);
        paths.set(key, path);
      }
      // Opening an asset in a new tab must never send its signed URL or filename to the web host.
      return `${location.origin}/.cove-assets/${owner}/${host}/${key}${url.hash}`;
    },
  });
  return {
    updateAddresses: peer.updateAddresses,
    httpBaseUrl: `https://${host}/`,
    wsBaseUrl: `wss://${host}/ws`,
    close: () => {
      unregister();
      assetPaths.delete(host);
      void peer.close().catch(() => {});
    },
  };
}

async function openBrowserPeer(input: EnvironmentTunnelDial) {
  let hints = input;
  const { openBrowserTunnel } = await import("@covecode/libp2p-tunnel/browser");
  const peer = await openBrowserTunnel({
    ...input,
    ...(input.discoveryBaseUrl && input.relays.length === 0
      ? {
          async refreshDirect(signal: AbortSignal) {
            // Only public address hints may be fetched here. The tunnel checks the original QR pin.
            const response = await fetch(
              new URL("/.well-known/t3/environment", hints.discoveryBaseUrl!),
              {
                credentials: "omit",
                referrerPolicy: "no-referrer",
                redirect: "error",
                cache: "no-store",
                signal,
              },
            );
            if (!response.ok) throw new Error("The paired environment is unavailable");
            const metadata = decodeLanDescriptor(await response.json());
            if (metadata.lanPeer.peerId !== input.peerId)
              throw new Error("The environment peer has changed");
            return metadata.lanPeer.direct;
          },
        }
      : {}),
  });
  return {
    ...peer,
    updateAddresses(next: EnvironmentTunnelDial) {
      peer.updateAddresses(next);
      hints = next;
    },
  };
}
