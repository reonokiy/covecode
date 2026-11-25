import { describe, expect, it } from "vite-plus/test";

import { deriveWsBaseUrl, environmentEndpointUrl, normalizeHttpBaseUrl } from "./endpoint.ts";
import { remoteApiBaseUrl } from "../rpc/http.ts";

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });

  it("preserves non-root tunnel path prefixes when resolving environment URLs", () => {
    expect(environmentEndpointUrl("https://example.com/", "/api/auth/session")).toBe(
      "https://example.com/api/auth/session",
    );
    expect(environmentEndpointUrl("https://relay.example.com/t/abc123", "/api/auth/session")).toBe(
      "https://relay.example.com/t/abc123/api/auth/session",
    );
    expect(
      environmentEndpointUrl("https://relay.example.com/t/abc123/?foo=1#bar", "api/auth/session"),
    ).toBe("https://relay.example.com/t/abc123/api/auth/session");

    expect(remoteApiBaseUrl("https://example.com?foo=1")).toBe("https://example.com/");
    expect(remoteApiBaseUrl("https://example.com/")).toBe("https://example.com/");
    expect(remoteApiBaseUrl("https://relay.example.com/t/abc123?x=1#h")).toBe(
      "https://relay.example.com/t/abc123/",
    );
    expect(remoteApiBaseUrl("https://relay.example.com/t/abc123/")).toBe(
      "https://relay.example.com/t/abc123/",
    );
  });
});
