import { describe, expect, it } from "vite-plus/test";

import { isSecureRelayUrl, normalizeSecureRelayUrl } from "./relayUrl.ts";

describe("normalizeSecureRelayUrl", () => {
  it("normalizes secure HTTPS and loopback HTTP relay origins", () => {
    expect(normalizeSecureRelayUrl(" https://relay.example.test/// ")).toBe(
      "https://relay.example.test",
    );
    expect(normalizeSecureRelayUrl("https://relay.example.test:8443/")).toBe(
      "https://relay.example.test:8443",
    );
    expect(normalizeSecureRelayUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(normalizeSecureRelayUrl("http://localhost:8787///")).toBe("http://localhost:8787");
    expect(normalizeSecureRelayUrl("http://[::1]:8787")).toBe("http://[::1]:8787");
  });

  it.each([
    "http://relay.example.test",
    "https://user:password@relay.example.test",
    "https://relay.example.test/path",
    "http://127.0.0.1:8787/path",
  ])("rejects unsafe relay URL %s", (value) => {
    expect(normalizeSecureRelayUrl(value)).toBeNull();
    expect(isSecureRelayUrl(value)).toBe(false);
  });
});
