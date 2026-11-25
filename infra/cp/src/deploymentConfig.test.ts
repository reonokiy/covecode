import { describe, expect, it } from "vite-plus/test";

import {
  endpointKeyFromTunnelName,
  extractEndpointKeyFromPath,
  extractEndpointKeyFromSubdomainHost,
  isManagedEndpointHostname,
  managedEndpointHostname,
  managedEndpointTunnelName,
  managedEndpointUrls,
} from "./deploymentConfig.ts";

describe("managed endpoint names and URLs", () => {
  it("keeps the DNS label within the provider limit for long namespace names", () => {
    const hostname = managedEndpointHostname(
      "dev_" + "x".repeat(100),
      "example.com",
      "a".repeat(64),
    );

    expect(hostname.split(".")[0]?.length).toBeLessThanOrEqual(63);
    expect(hostname).toMatch(/-a{16}\.example\.com$/);
  });

  it("rejects hostnames outside the relay zone", () => {
    expect(isManagedEndpointHostname("internal.example.net", "example.com")).toBe(false);
    expect(isManagedEndpointHostname("example.com.attacker.test", "example.com")).toBe(false);
    expect(isManagedEndpointHostname("dev-julius.example.com.", "example.com")).toBe(false);
  });

  it("defaults to path-prefix /t/<key>/ URLs when baseDomain is unset", () => {
    const urls = managedEndpointUrls({
      relayIssuer: "https://relay.example.com:8443/",
      endpointKey: "0123456789abcdef",
    });

    expect(urls).toEqual({
      hostname: "t/0123456789abcdef",
      httpBaseUrl: "https://relay.example.com:8443/t/0123456789abcdef/",
      wsBaseUrl: "wss://relay.example.com:8443/t/0123456789abcdef/ws",
    });
  });

  it("uses subdomain URLs when baseDomain is configured", () => {
    const urls = managedEndpointUrls({
      relayIssuer: "https://relay.example.com",
      endpointKey: "0123456789abcdef",
      baseDomain: "tunnels.example.com",
    });

    expect(urls).toEqual({
      hostname: "0123456789abcdef.tunnels.example.com",
      httpBaseUrl: "https://0123456789abcdef.tunnels.example.com/",
      wsBaseUrl: "wss://0123456789abcdef.t3unnels.example.com/ws".replace("t3unnels", "tunnels"),
    });
  });

  it("extracts endpoint keys from /t/<key>/ paths and subdomain hosts", () => {
    expect(extractEndpointKeyFromPath("/t/0123456789abcdef/ws")).toBe("0123456789abcdef");
    expect(extractEndpointKeyFromPath("/t/0123456789abcdef")).toBe("0123456789abcdef");
    expect(extractEndpointKeyFromPath("/t/not-hex/ws")).toBeNull();

    expect(
      extractEndpointKeyFromSubdomainHost(
        "dev-0123456789abcdef.tunnels.example.com:443",
        "tunnels.example.com",
      ),
    ).toBe("0123456789abcdef");
    expect(
      extractEndpointKeyFromSubdomainHost(
        "0123456789abcdef.tunnels.example.com",
        "tunnels.example.com",
      ),
    ).toBe("0123456789abcdef");
    expect(
      extractEndpointKeyFromSubdomainHost("other.example.com", "tunnels.example.com"),
    ).toBeNull();
  });

  it("parses current and legacy managed tunnel names", () => {
    expect(
      endpointKeyFromTunnelName(
        "selfhosted",
        managedEndpointTunnelName("selfhosted", "0123456789abcdef"),
      ),
    ).toBe("0123456789abcdef");
    expect(
      endpointKeyFromTunnelName("dev", "t3coderelay-managedendpoint-dev-0123456789abcdef"),
    ).toBe("0123456789abcdef");
  });
});
