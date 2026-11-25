import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  hasCloudPublicConfig,
  relayTelemetryEnabled,
  resolveRelayTracingConfig,
} from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("hasCloudPublicConfig", () => {
  it("rejects an insecure relay URL", () => {
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
  });

  it("accepts a secure relay URL on any browser origin", () => {
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubGlobal("window", { location: new URL("http://localhost:3773") });

    expect(hasCloudPublicConfig()).toBe(true);
  });
});

describe("relayTelemetryEnabled", () => {
  it("defaults off in ordinary browsers and requires explicit opt-in", () => {
    vi.stubGlobal("window", { location: new URL("https://example.com") });
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://telemetry.example.test/v1/traces");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "relay-test");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "test-token");

    expect(relayTelemetryEnabled()).toBe(false);
    expect(resolveRelayTracingConfig()).toBeNull();

    vi.stubEnv("VITE_T3CODE_TELEMETRY_ENABLED", "true");
    expect(relayTelemetryEnabled()).toBe(true);
    expect(resolveRelayTracingConfig()).toEqual({
      tracesUrl: "https://telemetry.example.test/v1/traces",
      tracesDataset: "relay-test",
      tracesToken: "test-token",
    });
  });
});
