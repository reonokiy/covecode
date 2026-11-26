import { describe, expect, it, vi } from "vite-plus/test";
import { discoverControlPlane, controlPlaneSessionKey } from "./controlPlane.ts";

describe("control panel discovery", () => {
  it("contacts only the selected panel and uses its identity provider and relay settings", async () => {
    const origin = "https://cp.example.test";
    const config = {
      controlPlaneUrl: origin,
      oidc: {
        issuer: "https://id.example.test/realms/cove",
        clientId: "my-client",
        audience: null,
        scopes: ["openid"],
      },
      libp2p: {
        enabled: true,
        peerId: "relay-id",
        relayMultiaddrs: ["/dns4/relay.example.test/tcp/443/tls/ws"],
      },
    };
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(config));
    expect(await discoverControlPlane(" https://CP.example.test/ ", request)).toEqual({
      origin,
      oidc: config.oidc,
      libp2p: config.libp2p,
    });
    expect(request).toHaveBeenCalledWith(
      new URL(origin + "/.well-known/cove-control-plane"),
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );
    const other = "https://other.example.test";
    request.mockResolvedValueOnce(Response.json(config));
    await expect(discoverControlPlane(other, request)).rejects.toThrow();
    expect(controlPlaneSessionKey(origin)).not.toBe(controlPlaneSessionKey(other));
    await expect(discoverControlPlane("http://other.example.test", request)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
