import { describe, expect, it, vi } from "vite-plus/test";

import { hasTracingPublicConfig, resolveCloudPublicConfig } from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("resolveCloudPublicConfig", () => {
  it("rejects an insecure relay URL", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
        relay: { url: "http://relay.example.test" },
      }),
    ).toEqual({
      clerk: {
        publishableKey: "pk_test_example",
        jwtTemplate: "t3-relay",
      },
      relay: {
        url: null,
      },
      observability: {
        telemetryEnabled: false,
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
    });
  });

  it("keeps tracing disabled by default even when OTLP credentials are present", () => {
    const credentials = {
      tracesUrl: "https://traces.example.test/v1/traces",
      tracesDataset: "mobile-traces",
      tracesToken: "test-token",
    };
    const disabled = resolveCloudPublicConfig({ observability: credentials });
    expect(disabled.observability.telemetryEnabled).toBe(false);
    expect(hasTracingPublicConfig(disabled)).toBe(false);

    const enabled = resolveCloudPublicConfig({
      observability: { ...credentials, telemetryEnabled: true },
    });
    expect(enabled.observability.telemetryEnabled).toBe(true);
    expect(hasTracingPublicConfig(enabled)).toBe(true);
  });
});
