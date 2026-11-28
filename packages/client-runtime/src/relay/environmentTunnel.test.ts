import { expect, it, vi } from "vite-plus/test";
import { createEnvironmentTunnels } from "./environmentTunnel.ts";

it("refreshes dial hints without closing the paired session, and releases it on identity change", async () => {
  const tunnel = { httpBaseUrl: "", wsBaseUrl: "", close: vi.fn(), updateAddresses: vi.fn() };
  const open = vi.fn(async () => tunnel);
  const verifyPeer = vi.fn(async (_id: string, peer: string) => {
    if (peer !== "paired") throw new Error("Unverified");
  });
  const tunnels = createEnvironmentTunnels({ open, verifyPeer });
  const endpoint = {
    providerKind: "libp2p_tunnel" as const,
    httpBaseUrl: "",
    wsBaseUrl: "",
    libp2pPeerId: "paired",
    libp2pDirectMultiaddrs: ["a", "b"],
  };
  const first = await tunnels.prepare("env", endpoint);
  expect(await tunnels.prepare("env", { ...endpoint, libp2pDirectMultiaddrs: ["b", "c"] })).toBe(
    first,
  );
  expect(open).toHaveBeenCalledTimes(1);
  expect(tunnel.close).not.toHaveBeenCalled();
  expect(tunnel.updateAddresses).toHaveBeenCalledWith(
    expect.objectContaining({ direct: ["b", "c"] }),
  );
  await expect(tunnels.prepare("env", { ...endpoint, libp2pPeerId: "unknown" })).rejects.toThrow(
    "Unverified",
  );
  expect(tunnel.close).toHaveBeenCalledTimes(1);
});

it("uses the latest hints when addresses change during the first dial", async () => {
  const started = Promise.withResolvers<void>();
  const dialing = Promise.withResolvers<never>();
  const ready = { httpBaseUrl: "", wsBaseUrl: "", close: vi.fn(), updateAddresses: vi.fn() };
  const tried: string[] = [];
  const tunnels = createEnvironmentTunnels({
    verifyPeer: async () => {},
    open: async ({ direct }) => {
      tried.push(...direct);
      if (direct.includes("old")) {
        started.resolve();
        return dialing.promise;
      }
      return ready;
    },
  });
  const peer = { peerId: "paired", direct: ["old"], discoveryBaseUrl: "https://example.test" };
  const first = tunnels.lan.prepare(peer);
  await started.promise;
  const refreshed = tunnels.lan.prepare({ ...peer, direct: ["new"] });
  dialing.reject(new Error("Old address unreachable"));
  expect(await Promise.all([first, refreshed])).toEqual([ready, ready]);
  expect(tried).toEqual(["old", "new"]);
  tunnels.lan.release(peer.peerId);
});
