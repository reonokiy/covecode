// Browser-owned media requests stream through the page which owns the environment connection.
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
  if (event.data?.type === "cove-tunnel-owner") event.ports[0]?.postMessage(event.source.id);
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const match =
    url.origin === self.location.origin &&
    /^\/\.cove-assets\/([a-zA-Z0-9-]+)\/([a-f0-9]{32}\.cove\.invalid)\/([a-f0-9-]{36})$/u.exec(
      url.pathname,
    );
  if (match) {
    event.respondWith(resource(event, match[1], { host: match[2], asset: match[3] }));
  } else if (url.origin === self.location.origin && url.pathname.startsWith("/.cove-assets/")) {
    event.respondWith(Response.error());
  } else if (url.protocol === "https:" && /^[a-f0-9]{32}\.cove\.invalid$/u.test(url.hostname)) {
    event.respondWith(
      resource(event, event.clientId, { host: url.hostname, path: url.pathname + url.search }),
    );
  }
});

async function resource(event, owner, target) {
  if (
    !["GET", "HEAD"].includes(event.request.method) ||
    !owner ||
    ![
      "",
      "image",
      "audio",
      "video",
      "track",
      "document",
      "frame",
      "iframe",
      "object",
      "embed",
    ].includes(event.request.destination)
  )
    return Response.error();
  const page = await self.clients.get(owner);
  if (!page) return Response.error();
  const { port1: port, port2 } = new MessageChannel();
  const { signal } = event.request;
  let pending;
  let timer;
  const finish = () => {
    clearTimeout(timer);
    pending = undefined;
    signal.removeEventListener("abort", cancel);
    port.close();
  };
  function cancel() {
    port.postMessage({ cancel: true });
    pending?.(new Error("Tunnel resource request cancelled"));
    finish();
  }
  const next = () =>
    new Promise((resolve, reject) => {
      pending = reject;
      timer = setTimeout(cancel, 30_000);
      port.onmessageerror = cancel;
      port.onmessage = ({ data }) => {
        clearTimeout(timer);
        pending = undefined;
        if (data.error) {
          finish();
          reject(new Error("Tunnel resource request failed"));
        } else resolve(data);
      };
    });
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    cancel();
    return Response.error();
  }
  const head = next();
  page.postMessage(
    {
      type: "cove-tunnel-resource",
      ...target,
      method: event.request.method,
      headers: [...event.request.headers].filter(([name]) =>
        ["accept", "range", "if-range", "if-none-match", "if-modified-since"].includes(name),
      ),
    },
    [port2],
  );
  const meta = await head;
  const headers = new Headers(
    meta.headers.filter(([name]) =>
      /^(?:content-(?:type|disposition|range|length)|accept-ranges|etag|last-modified)$/iu.test(
        name,
      ),
    ),
  );
  const mime = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const policy = new Headers(meta.headers).get("content-security-policy");
  if (policy) headers.set("content-security-policy", policy);
  if (mime !== "application/pdf") {
    // Asset documents share the app URL space. Keep their origin opaque and embedded content local.
    headers.append(
      "content-security-policy",
      "sandbox allow-scripts allow-forms allow-downloads; default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'",
    );
  }
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  const body = meta.body
    ? new ReadableStream({
        async pull(controller) {
          const response = next();
          port.postMessage({ pull: true });
          const { bytes, done } = await response;
          if (done) {
            finish();
            controller.close();
          } else controller.enqueue(bytes);
        },
        cancel,
      })
    : null;
  if (!meta.body) finish();
  return new Response(body, { status: meta.status, headers });
}
