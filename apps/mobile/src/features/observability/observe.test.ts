import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mockState = vi.hoisted(() => ({
  extra: {} as Record<string, unknown>,
  loadPreferences: vi.fn<() => Promise<{ readonly crashReportsEnabled?: boolean }>>(
    async () => ({}),
  ),
  configure: vi.fn(),
  dispatchEvents: vi.fn(async () => undefined),
  reportError: vi.fn(),
}));

vi.mock("expo-constants", () => ({
  default: {
    get expoConfig() {
      return { extra: mockState.extra };
    },
  },
}));

vi.mock("expo-observe", () => ({
  Observe: {
    configure: mockState.configure,
    dispatchEvents: mockState.dispatchEvents,
    reportError: mockState.reportError,
  },
}));

vi.mock("../../persistence/imperative", () => ({
  loadPreferences: () => mockState.loadPreferences(),
}));

afterEach(() => {
  vi.resetModules();
  mockState.extra = {};
  mockState.loadPreferences.mockReset();
  mockState.loadPreferences.mockResolvedValue({});
  mockState.configure.mockReset();
  mockState.dispatchEvents.mockReset();
  mockState.dispatchEvents.mockResolvedValue(undefined);
  mockState.reportError.mockReset();
});

describe("mobile observe crash reporting", () => {
  it("stays unavailable and disabled when observeEndpointUrl is .invalid", async () => {
    mockState.extra = {
      appVariant: "production",
      relay: { url: "https://relay.example.test" },
      eas: { observe: { endpointUrl: "https://observe.invalid" } },
    };

    const observe = await import("./observe");

    expect(observe.crashReportingAvailable).toBe(false);
    await vi.waitFor(() => {
      expect(mockState.configure).toHaveBeenCalledWith({
        dispatchingEnabled: false,
        environment: "production",
      });
    });
    observe.reportCrashError(new Error("boom"));
    expect(mockState.reportError).not.toHaveBeenCalled();
  });

  it("defaults crash reporting off when preferences omit crashReportsEnabled", async () => {
    mockState.extra = {
      appVariant: "production",
      relay: { url: "https://relay.example.test" },
      eas: { observe: { endpointUrl: "https://relay.example.test/v1/mobile/observe" } },
    };
    mockState.loadPreferences.mockResolvedValue({});

    const observe = await import("./observe");

    expect(observe.crashReportingAvailable).toBe(true);
    await vi.waitFor(() => {
      expect(mockState.configure).toHaveBeenCalledWith({
        dispatchingEnabled: false,
        environment: "production",
      });
    });
    observe.reportCrashError(new Error("boom"));
    expect(mockState.reportError).not.toHaveBeenCalled();
  });

  it("enables crash reporting only when explicitly opted in", async () => {
    mockState.extra = {
      appVariant: "production",
      relay: { url: "https://relay.example.test" },
      eas: { observe: { endpointUrl: "https://relay.example.test/v1/mobile/observe" } },
    };
    mockState.loadPreferences.mockResolvedValue({ crashReportsEnabled: true });

    const observe = await import("./observe");

    expect(observe.crashReportingAvailable).toBe(true);
    await vi.waitFor(() => {
      expect(mockState.dispatchEvents).toHaveBeenCalledOnce();
      expect(mockState.configure).toHaveBeenCalledWith({
        dispatchingEnabled: true,
        environment: "production",
      });
    });
    const error = new Error("opted-in");
    observe.reportCrashError(error);
    expect(mockState.reportError).toHaveBeenCalledWith(error);
  });

  it("fails closed when reading preferences fails", async () => {
    mockState.extra = {
      appVariant: "production",
      relay: { url: "https://relay.example.test" },
      eas: { observe: { endpointUrl: "https://relay.example.test/v1/mobile/observe" } },
    };
    mockState.loadPreferences.mockRejectedValue(new Error("storage unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const observe = await import("./observe");

      await vi.waitFor(() => {
        expect(mockState.configure).toHaveBeenCalledWith({
          dispatchingEnabled: false,
          environment: "production",
        });
      });
      observe.reportCrashError(new Error("boom"));
      expect(mockState.reportError).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
