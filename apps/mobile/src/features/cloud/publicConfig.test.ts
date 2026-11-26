import { describe, expect, it, vi } from "vite-plus/test";

import {
  cloudDraftOwner,
  hasTracingPublicConfig,
  loadControlPlaneSelection,
  resolveCloudPublicConfig,
} from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: { relay: { url: "https://bundled.example.test" } },
    },
  },
}));

vi.mock("../../lib/protectedData", () => ({ whenProtectedDataAvailable: async () => {} }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) =>
    key === "cove.control-plane" ? "https://chosen.example.test/" : null,
}));

describe("resolveCloudPublicConfig", () => {
  it("waits for the saved control panel before publishing a destination for this launch", async () => {
    expect(resolveCloudPublicConfig().relay.url).toBeNull();
    await loadControlPlaneSelection();
    expect(resolveCloudPublicConfig().relay.url).toBe("https://chosen.example.test");
    expect(cloudDraftOwner("same-subject")).not.toBe("same-subject");
  });

  it("rejects an insecure relay URL", () => {
    expect(
      resolveCloudPublicConfig({
        relay: { url: "http://relay.example.test" },
      }),
    ).toEqual({
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
