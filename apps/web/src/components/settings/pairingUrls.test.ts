import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
    expect(
      resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE", {
        peerId: "12D3KooWPeerId",
        direct: [
          "/ip4/192.168.1.44/tcp/4100/p2p/12D3KooWPeerId",
          "/ip4/192.168.1.44/tcp/4101/ws/p2p/12D3KooWPeerId",
        ],
      }),
    ).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE&peer=12D3KooWPeerId&addr=%2Fip4%2F192.168.1.44%2Ftcp%2F4100%2Fp2p%2F12D3KooWPeerId&addr=%2Fip4%2F192.168.1.44%2Ftcp%2F4101%2Fws%2Fp2p%2F12D3KooWPeerId",
    );
  });

  it("uses hosted pairing URLs for HTTPS endpoints", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://preview.t3.codes/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A3773#token=PAIRCODE",
    );
  });
});
