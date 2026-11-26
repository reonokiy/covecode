import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildPairingUrl,
  extractPairingUrlFromQrPayload,
  parsePairingUrl,
  readPinnedPairingUrl,
  resolveRoutePairingUrl,
} from "./pairing";

const VALID_PEER_ID = "12D3KooW11111111111111111111111111111111111111111111";
const PINNED_LAN_URL = `http://192.168.1.100:3773/pair#token=pairing-token&peer=${VALID_PEER_ID}&addr=${encodeURIComponent(`/ip4/192.168.1.100/tcp/4100/p2p/${VALID_PEER_ID}`)}`;

describe("buildPairingUrl", () => {
  it("uses HTTP for a schemeless IP address", () => {
    expect(buildPairingUrl("192.168.1.100:3773", "pairing-token")).toBe(
      "http://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("keeps HTTPS as the default for a schemeless hostname", () => {
    expect(buildPairingUrl("remote.example.com", "pairing-token")).toBe(
      "https://remote.example.com/#token=pairing-token",
    );
  });

  it("preserves an explicit scheme for an IP address", () => {
    expect(buildPairingUrl("https://192.168.1.100:3773", "pairing-token")).toBe(
      "https://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("preserves LAN peer and repeated addr fragment fields from a full pairing URL", () => {
    const source =
      "http://192.168.1.100:3773/pair#token=pairing-token&peer=12D3KooWPeerId&addr=%2Fip4%2F192.168.1.100%2Ftcp%2F4100%2Fp2p%2F12D3KooWPeerId&addr=%2Fip4%2F192.168.1.100%2Ftcp%2F4101%2Fws%2Fp2p%2F12D3KooWPeerId";
    expect(buildPairingUrl("http://192.168.1.100:3773", "pairing-token", source)).toBe(source);
    expect(buildPairingUrl("http://192.168.1.100:3773", "updated-token", source)).toBe(
      source.replace("token=pairing-token", "token=updated-token"),
    );
    expect(buildPairingUrl("http://192.168.1.101:3773", "pairing-token", source)).toBe(
      "http://192.168.1.101:3773/#token=pairing-token",
    );
  });
});

describe("extractPairingUrlFromQrPayload", () => {
  it("unwraps mobile deep links that carry an encoded pairing url", () => {
    const lanUrl =
      "http://192.168.1.100:3773/pair#token=pairing-token&peer=12D3KooWPeerId&addr=%2Fip4%2F192.168.1.100%2Ftcp%2F4100%2Fp2p%2F12D3KooWPeerId";
    expect(
      extractPairingUrlFromQrPayload(
        "covecode://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
      ),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
    expect(
      extractPairingUrlFromQrPayload(`covecode://pair?pairingUrl=${encodeURIComponent(lanUrl)}`),
    ).toBe(lanUrl);
  });
});

describe("parsePairingUrl", () => {
  it("reads hosted pairing links into backend host fields", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=pairing-token",
      ),
    ).toEqual({
      host: "https://desktop.tailnet.ts.net",
      code: "pairing-token",
    });
  });
});

describe("resolveRoutePairingUrl", () => {
  it("prefills only valid peer-pinned pairing links in production builds", () => {
    vi.stubGlobal("__DEV__", false);
    expect(readPinnedPairingUrl(PINNED_LAN_URL)).toBe(PINNED_LAN_URL);
    expect(
      resolveRoutePairingUrl(`covecode://pair?pairingUrl=${encodeURIComponent(PINNED_LAN_URL)}`),
    ).toBe(PINNED_LAN_URL);
    expect(resolveRoutePairingUrl("http://192.168.1.100:3773/pair#token=pairing-token")).toBe("");
    expect(
      resolveRoutePairingUrl(
        "http://192.168.1.100:3773/pair#token=pairing-token&peer=invalid-peer",
      ),
    ).toBe("");

    vi.stubGlobal("__DEV__", true);
    expect(resolveRoutePairingUrl("http://192.168.1.100:3773/pair#token=pairing-token")).toBe(
      "http://192.168.1.100:3773/pair#token=pairing-token",
    );
  });
});
