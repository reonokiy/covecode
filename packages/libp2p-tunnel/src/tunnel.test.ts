import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { WebSocket, WebSocketServer } from "ws";

import {
  createClientLibp2pProxy,
  createEnvironmentLibp2pTunnel,
  createRelayLibp2pNode,
  isAllowedLoopbackHost,
  TunnelRegistrationUnauthorizedError,
} from "./index.ts";

interface OriginFixture {
  readonly port: number;
  readonly close: () => Promise<void>;
}

async function startOriginFixture(): Promise<OriginFixture> {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws, req) => {
    ws.send(JSON.stringify({ type: "welcome", url: req.url ?? "/" }));
    ws.on("message", (data, isBinary) => {
      const text = isBinary ? Buffer.from(data as Buffer).toString("utf8") : String(data);
      ws.send(`echo:${text}`);
    });
  });

  const server = NodeHttp.createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("x-origin-header", "from-origin");
      res.end(JSON.stringify({ ok: true, method: req.method, path: req.url }));
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/echo")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const bodyText = Buffer.concat(chunks).toString("utf8");
      res.statusCode = 201;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          url: req.url,
          customHeader: req.headers["x-cove-test"] ?? null,
          body: JSON.parse(bodyText) as unknown,
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as NodeNet.AddressInfo;
  return {
    port: address.port,
    close: async () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startGatewayHttpServer(options: {
  readonly endpointKey: string;
  readonly stripPathPrefix: string;
  readonly relay: Awaited<ReturnType<typeof createRelayLibp2pNode>>;
}) {
  const server = NodeHttp.createServer((req, res) => {
    void options.relay.proxyHttpRequest(options.endpointKey, req, res, {
      stripPathPrefix: options.stripPathPrefix,
    });
  });
  server.on("upgrade", (req, socket, head) => {
    void options.relay.proxyUpgrade(options.endpointKey, req, socket, head, {
      stripPathPrefix: options.stripPathPrefix,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as NodeNet.AddressInfo;
  return {
    httpBaseUrl: `http://127.0.0.1:${address.port}${options.stripPathPrefix}`,
    wsBaseUrl: `ws://127.0.0.1:${address.port}${options.stripPathPrefix}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("libp2p-tunnel", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) {
        await fn();
      }
    }
  });

  it("validates loopback origin hosts", () => {
    expect(isAllowedLoopbackHost("127.0.0.1")).toBe(true);
    expect(isAllowedLoopbackHost("localhost")).toBe(true);
    expect(isAllowedLoopbackHost("::1")).toBe(true);
    expect(isAllowedLoopbackHost("10.0.0.5")).toBe(false);
    expect(isAllowedLoopbackHost("example.com")).toBe(false);
  });

  it("rejects non-loopback localHost in createEnvironmentLibp2pTunnel", async () => {
    await expect(
      createEnvironmentLibp2pTunnel({
        relayMultiaddrs: ["/ip4/127.0.0.1/tcp/12345/ws"],
        endpointId: "env-1",
        endpointKey: "key-1",
        connectorToken: "secret",
        localHost: "192.168.1.50",
        localPort: 3773,
      }),
    ).rejects.toThrow(/non-loopback/u);
  });

  it("rejects unauthorized tunnel registrations", async () => {
    const relay = await createRelayLibp2pNode({
      listenMultiaddrs: ["/ip4/127.0.0.1/tcp/0/ws"],
      validateRegistration: () => false,
    });
    cleanups.push(() => relay.stop());

    await expect(
      createEnvironmentLibp2pTunnel({
        relayMultiaddrs: relay.getMultiaddrs(),
        endpointId: "env-unauth",
        endpointKey: "unauth-key",
        connectorToken: "wrong-token",
        localHost: "127.0.0.1",
        localPort: 39999,
        enableP2p: false,
      }),
    ).rejects.toBeInstanceOf(TunnelRegistrationUnauthorizedError);

    expect(relay.isEndpointConnected("unauth-key")).toBe(false);
  });

  it("reserves both replicas and keeps serving when one stops", async () => {
    const origin = await startOriginFixture();
    cleanups.push(origin.close);
    const firstReady = Promise.withResolvers<void>();
    const secondReady = Promise.withResolvers<void>();
    const first = await createRelayLibp2pNode({
      validateRegistration: () => true,
      onEndpointReady: () => firstReady.resolve(),
    });
    const second = await createRelayLibp2pNode({
      validateRegistration: () => true,
      onEndpointReady: () => secondReady.resolve(),
    });
    cleanups.push(first.stop, second.stop);
    const tunnel = await createEnvironmentLibp2pTunnel({
      relayMultiaddrs: [...first.getMultiaddrs(), ...second.getMultiaddrs()],
      endpointId: "env-ha",
      endpointKey: "ha",
      connectorToken: "token",
      localHost: "127.0.0.1",
      localPort: origin.port,
      enableP2p: false,
    });
    cleanups.push(tunnel.stop);
    await Promise.all([firstReady.promise, secondReady.promise]);
    await first.stop();
    expect(tunnel.isConnected()).toBe(true);
    const proxy = await createClientLibp2pProxy({
      relayMultiaddrs: second.getMultiaddrs(),
      targetPeerId: tunnel.peerId,
      mode: "relay",
    });
    cleanups.push(proxy.stop);
    expect((await fetch(new URL("healthz", proxy.httpBaseUrl + "/"))).status).toBe(200);
  });

  it("re-registers and restores its reservation when a control plane restarts", async () => {
    const privateKey = await generateKeyPair("Ed25519");
    const relayOptions = { privateKey, validateRegistration: () => true };
    let relay = await createRelayLibp2pNode(relayOptions);
    cleanups.push(() => relay.stop());
    const relayAddress = relay.getMultiaddrs()[0]!;
    const restored = Promise.withResolvers<readonly string[]>();
    let waitingForReconnect = false;
    const tunnel = await createEnvironmentLibp2pTunnel({
      relayMultiaddrs: [relayAddress],
      endpointId: "env-reconnect",
      endpointKey: "reconnect-key",
      connectorToken: "token",
      localHost: "127.0.0.1",
      localPort: 39999,
      enableP2p: false,
      onStatusChange: ({ state, circuitMultiaddrs }) => {
        if (waitingForReconnect && state === "connected") restored.resolve(circuitMultiaddrs);
      },
    });
    cleanups.push(tunnel.stop);
    waitingForReconnect = true;
    await relay.stop();
    relay = await createRelayLibp2pNode({
      ...relayOptions,
      listenMultiaddrs: [relayAddress.replace(/\/p2p\/[^/]+$/u, "")],
    });
    expect(await restored.promise).toEqual([expect.stringContaining("/p2p-circuit/")]);
    expect(relay.getEndpointRegistration("reconnect-key")?.peerId).toBe(tunnel.peerId);
  });

  it("proxies HTTP requests, headers, POST bodies, and WebSockets with path prefix stripping", async () => {
    const origin = await startOriginFixture();
    cleanups.push(() => origin.close());

    const relay = await createRelayLibp2pNode({
      listenMultiaddrs: ["/ip4/127.0.0.1/tcp/0/ws", "/ip4/127.0.0.1/tcp/0"],
      validateRegistration: (input) =>
        input.endpointId === "env-1" &&
        input.endpointKey === "abc123" &&
        input.connectorToken === "good-token",
    });
    cleanups.push(() => relay.stop());

    const tunnel = await createEnvironmentLibp2pTunnel({
      relayMultiaddrs: relay.getMultiaddrs(),
      endpointId: "env-1",
      endpointKey: "abc123",
      connectorToken: "good-token",
      localHost: "127.0.0.1",
      localPort: origin.port,
    });
    cleanups.push(() => tunnel.stop());

    expect(relay.isEndpointConnected("abc123")).toBe(true);
    expect(relay.getEndpointRegistration("abc123")?.peerId).toBe(tunnel.peerId);
    expect(relay.getEndpointRegistration("abc123")?.directMultiaddrs).toEqual(
      expect.arrayContaining([expect.stringContaining(`/p2p/${tunnel.peerId}`)]),
    );

    const gateway = await startGatewayHttpServer({
      endpointKey: "abc123",
      stripPathPrefix: "/t/abc123",
      relay,
    });
    cleanups.push(() => gateway.close());

    const getResponse = await fetch(`${gateway.httpBaseUrl}/healthz`);
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get("x-origin-header")).toBe("from-origin");
    expect(await getResponse.json()).toEqual({ ok: true, method: "GET", path: "/healthz" });

    const postResponse = await fetch(`${gateway.httpBaseUrl}/echo?foo=bar`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cove-test": "hello-p2p",
      },
      body: JSON.stringify({ payload: 42 }),
    });
    expect(postResponse.status).toBe(201);
    expect(await postResponse.json()).toEqual({
      url: "/echo?foo=bar",
      customHeader: "hello-p2p",
      body: { payload: 42 },
    });

    const wsMessages = await new Promise<string[]>((resolve, reject) => {
      const ws = new WebSocket(`${gateway.wsBaseUrl}/ws?token=xyz`);
      const received: string[] = [];
      ws.once("error", reject);
      ws.on("message", (data) => {
        received.push(String(data));
        if (received.length === 1) {
          ws.send("ping-from-client");
        } else if (received.length === 2) {
          ws.close();
          resolve(received);
        }
      });
    });

    expect(JSON.parse(wsMessages[0] ?? "{}")).toEqual({
      type: "welcome",
      url: "/ws?token=xyz",
    });
    expect(wsMessages[1]).toBe("echo:ping-from-client");
  });

  it.each([false, true])(
    "streams browser HTTP and WebSocket with direct connectivity %s",
    async (direct) => {
      const origin = await startOriginFixture();
      cleanups.push(origin.close);
      const relay = await createRelayLibp2pNode({
        listenMultiaddrs: ["/ip4/127.0.0.1/tcp/0/ws"],
        validateRegistration: () => true,
      });
      cleanups.push(relay.stop);
      const tunnel = await createEnvironmentLibp2pTunnel({
        endpointId: "browser-test",
        endpointKey: "browser",
        connectorToken: "test",
        relayMultiaddrs: relay.getMultiaddrs(),
        localHost: "127.0.0.1",
        localPort: origin.port,
        enableP2p: direct,
      });
      cleanups.push(tunnel.stop);
      await tunnel.waitForRelayReservation(10_000);
      const { openBrowserTunnel } = await import("./browser.ts");
      const browser = await openBrowserTunnel({
        peerId: tunnel.peerId,
        direct: [],
        relays: relay.getMultiaddrs(),
      });
      expect(browser.getActiveTransport()).toBe(direct ? "direct" : "relay");
      cleanups.push(async () => {
        await browser.close();
      });
      let sent = 0;
      const payload = JSON.stringify({ text: "hello" });
      const res = await browser.fetch(
        new Request("https://client.invalid/echo?q=1", {
          method: "POST",
          headers: { "x-cove-test": "encrypted" },
          body: payload,
        }),
        (bytes) => {
          sent = bytes;
        },
      );
      expect(sent).toBe(Buffer.byteLength(payload));
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        url: "/echo?q=1",
        customHeader: "encrypted",
        body: { text: "hello" },
      });
      const socket = browser.socket(new URL("wss://client.invalid/ws?test=browser"), ["cove-test"]);
      const reply = await new Promise<string>((resolve, reject) => {
        socket.onerror = () => reject(new Error("Browser socket failed"));
        socket.onmessage = ({ data }) => {
          if (typeof data === "string" && data.startsWith("echo:")) resolve(data);
          else socket.send("ping");
        };
      });
      expect(socket.protocol).toBe("cove-test");
      expect(reply).toBe("echo:ping");
      const closed = new Promise<CloseEvent>((resolve) => {
        socket.onclose = resolve;
      });
      socket.close(4001, "finished");
      expect(await closed).toMatchObject({ code: 4001, reason: "finished", wasClean: true });
    },
  );

  it("proxies HTTP and WebSockets via createClientLibp2pProxy in both relay and p2p modes", async () => {
    const origin = await startOriginFixture();
    cleanups.push(() => origin.close());

    const relay = await createRelayLibp2pNode({
      listenMultiaddrs: ["/ip4/127.0.0.1/tcp/0/ws", "/ip4/127.0.0.1/tcp/0"],
      connectionLimits: { durationMs: 120_000, bytes: 1_048_576 },
      validateRegistration: () => true,
    });
    cleanups.push(() => relay.stop());

    const tunnel = await createEnvironmentLibp2pTunnel({
      relayMultiaddrs: relay.getMultiaddrs(),
      endpointId: "env-p2p",
      endpointKey: "p2p-key",
      connectorToken: "token",
      localHost: "127.0.0.1",
      localPort: origin.port,
      enableP2p: true,
    });
    cleanups.push(() => tunnel.stop());

    const circuitAddrs = await tunnel.waitForRelayReservation(10_000);
    const circuit = circuitAddrs.find(
      (addr) => addr.includes("/ws/p2p/") && addr.endsWith(`/p2p-circuit/p2p/${tunnel.peerId}`),
    );
    expect(circuit).toBeDefined();
    const client = await createLibp2p({
      transports: [webSockets(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    });
    cleanups.push(async () => client.stop());
    const connection = await client.dial(multiaddr(circuit!));
    expect(connection.limits?.bytes).toBeGreaterThan(0n);
    expect(connection.limits?.bytes).toBeLessThanOrEqual(1_048_576n);

    const relayProxy = await createClientLibp2pProxy({
      relayMultiaddrs: relay.getMultiaddrs(),
      targetPeerId: tunnel.peerId,
      mode: "relay",
    });
    cleanups.push(() => relayProxy.stop());

    const transportRelay = await relayProxy.connect();
    expect(transportRelay).toBe("relay");

    const relayRes = await fetch(`${relayProxy.httpBaseUrl}/healthz`);
    expect(relayRes.status).toBe(200);
    expect(await relayRes.json()).toEqual({ ok: true, method: "GET", path: "/healthz" });

    const p2pProxy = await createClientLibp2pProxy({
      relayMultiaddrs: relay.getMultiaddrs(),
      targetPeerId: tunnel.peerId,
      directMultiaddrs: relay.getEndpointRegistration("p2p-key")!.directMultiaddrs,
      mode: "p2p",
    });
    cleanups.push(() => p2pProxy.stop());

    const transportP2p = await p2pProxy.connect();
    expect(transportP2p).toBe("direct");
    expect((await fetch(new URL("/healthz", p2pProxy.httpBaseUrl))).status).toBe(404);

    const p2pWsReply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`${p2pProxy.wsBaseUrl}/ws?mode=p2p`);
      let count = 0;
      ws.once("error", reject);
      ws.on("message", (data) => {
        count += 1;
        if (count === 1) {
          ws.send("hello-dcutr");
        } else {
          ws.close();
          resolve(String(data));
        }
      });
    });
    expect(p2pWsReply).toBe("echo:hello-dcutr");
  });
});
