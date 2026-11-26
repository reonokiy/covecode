import { controlPlaneSessionKey } from "@t3tools/client-runtime/relay";
import { afterEach, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("keeps a tab on its chosen panel and restores only that panel's session after navigation", async () => {
  const first = "https://first.example.test";
  const second = "https://second.example.test";
  const oidc = {
    issuer: "https://id.example.test",
    clientId: "shared",
    audience: null,
    scopes: ["openid"],
  };
  const stored = new Map([
    ["cove.control-plane", second],
    [
      controlPlaneSessionKey(first),
      JSON.stringify({
        issuer: oidc.issuer,
        clientId: oidc.clientId,
        user: { id: "user", name: null, email: null, picture: null },
        tokens: {
          accessToken: "first-token",
          expiresAtMillis: null,
          idToken: null,
          refreshToken: null,
        },
      }),
    ],
  ]);
  const tab = new Map([["cove.control-plane", first]]);
  vi.stubGlobal("window", {
    location: new URL("https://app.example.test/"),
    localStorage: { getItem: (key: string) => stored.get(key) ?? null },
    sessionStorage: { getItem: (key: string) => tab.get(key) ?? null },
  });
  const request = vi.fn<typeof fetch>().mockImplementation(async (input) =>
    Response.json({
      controlPlaneUrl: new URL(String(input)).origin,
      oidc,
      libp2p: { enabled: false, peerId: null, relayMultiaddrs: [] },
    }),
  );
  vi.stubGlobal("fetch", request);
  const existingTab = await import("./oidcAuth");
  expect(await existingTab.getCloudToken()).toBe("first-token");
  tab.clear();
  vi.resetModules();
  const newTab = await import("./oidcAuth");
  expect(await newTab.getCloudToken()).toBeNull();
  expect(request.mock.calls.map(([url]) => String(url))).toEqual([
    first + "/.well-known/cove-control-plane",
    second + "/.well-known/cove-control-plane",
  ]);
});
