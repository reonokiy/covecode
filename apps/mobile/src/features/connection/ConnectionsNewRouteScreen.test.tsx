import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { Children, harness } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => <>{children}</>,
  harness: {
    // The app-wide error slot other features (composer sends, branch refreshes) write to.
    pendingConnectionError: null as string | null,
    connectPress: vi.fn(),
    onBarcodeScanned: null as ((result: { readonly data: string }) => void) | null,
    submitAction: null as (() => void) | null,
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  Pressable: Children,
  Linking: { openSettings: vi.fn() },
  StyleSheet: { absoluteFill: {} },
}));
vi.mock("react-native-svg", () => ({
  default: Children,
  Defs: Children,
  RadialGradient: Children,
  Rect: () => null,
  Stop: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  StackActions: { replace: vi.fn() },
  useIsFocused: () => true,
  useNavigation: () => ({ canGoBack: () => true, goBack: vi.fn(), dispatch: vi.fn() }),
  useRoute: () => ({ name: "ConnectionsNew" }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../cloud/useMobileCloudAuth", () => ({
  useMobileCloudAuth: () => ({
    isLoaded: false,
    isSignedIn: false,
    userId: null,
    user: null,
    getToken: () => Promise.resolve(null),
    signIn: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
  }),
}));
vi.mock("expo-camera", () => ({
  CameraView: ({
    onBarcodeScanned,
  }: {
    onBarcodeScanned?: (result: { readonly data: string }) => void;
  }) => {
    harness.onBarcodeScanned = onBarcodeScanned ?? null;
    return null;
  },
  useCameraPermissions: () => [{ granted: true, canAskAgain: true }, vi.fn()],
}));
vi.mock("expo-haptics", () => ({
  notificationAsync: vi.fn(async () => {}),
  NotificationFeedbackType: { Success: "success", Error: "error" },
}));
vi.mock("../../components/ui/ListRow", () => ({ ListRow: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppTextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onChange={(event) => onChangeText(event.currentTarget.value)}
    />
  ),
}));
vi.mock("../../components/ui/FrostedCutout", () => ({ FrostedCutout: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: ({
    children,
    actions,
  }: {
    children?: ReactNode;
    actions?: ReadonlyArray<{ readonly onPress: () => void }>;
  }) => {
    harness.submitAction = actions?.[0]?.onPress ?? null;
    return <>{children}</>;
  },
}));
vi.mock("../settings/settings-navigation", () => ({
  leaveSettingsPage: vi.fn(),
  openSettings: vi.fn(),
}));
vi.mock("../layout/workspace/workspace-selection-store", () => ({
  workspaceHasColumns: () => false,
}));
vi.mock("../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("./CloudEnvironmentRows", () => ({ CloudEnvironmentRows: () => null }));
vi.mock("./environmentSections", () => ({
  splitEnvironmentSections: () => ({ connectedCloudEnvironments: [] }),
}));
vi.mock("./devAutoConnect", () => ({
  autoConnectReport: () => ({ connecting: false, error: null }),
  devAutoConnectAttemptAtom: {},
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  setPendingConnectionError: (message: string | null) => {
    harness.pendingConnectionError = message;
  },
  useRemoteConnections: () => ({
    connectionPairingUrl: "",
    connectedEnvironments: [],
    pairingConnectionError: harness.pendingConnectionError,
    onChangeConnectionPairingUrl: vi.fn(),
    onConnectPress: harness.connectPress,
    onSetEnvironmentEnabled: vi.fn(),
    onRemoveEnvironmentPress: vi.fn(),
  }),
}));

import { ConnectionsNewRouteScreen } from "./ConnectionsNewRouteScreen";

it("does not show another feature's error as a pairing failure", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("__DEV__", false);
  harness.pendingConnectionError = "Could not send the message.";
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<ConnectionsNewRouteScreen route={{ params: undefined }} />));

  expect(container.textContent).not.toContain("Could not send the message.");
  expect(container.textContent).toContain("For machines on your local network or tailnet.");

  act(() => root.unmount());
  // Leaving the form must not wipe an error that belongs to another screen.
  expect(harness.pendingConnectionError).toBe("Could not send the message.");
});

it("splits a pasted pairing link and preserves the code during address edits", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("__DEV__", false);
  harness.pendingConnectionError = null;
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    act(() => root.render(<ConnectionsNewRouteScreen route={{ params: undefined }} />));
    const address = container.querySelector<HTMLInputElement>('input[aria-label="Address"]')!;
    const code = container.querySelector<HTMLInputElement>('input[aria-label="Code"]')!;
    const enter = (input: HTMLInputElement, value: string) => {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    enter(code, "manual-code");
    const pastedLanUrl =
      "http://100.82.53.91:3773/pair#token=test-pairing-code&peer=12D3KooWPeerId&addr=%2Fip4%2F100.82.53.91%2Ftcp%2F4100%2Fp2p%2F12D3KooWPeerId";
    enter(address, `  ${pastedLanUrl}\n`);
    expect(address.value).toBe("http://100.82.53.91:3773");
    expect(code.value).toBe("test-pairing-code");

    harness.connectPress.mockClear().mockResolvedValueOnce({ ok: false, error: null });
    await act(async () => {
      harness.submitAction?.();
    });
    expect(harness.connectPress).toHaveBeenCalledExactlyOnceWith(pastedLanUrl, undefined);

    enter(code, "replacement-code");
    for (const value of ["", "100.82.53.92:3773", "http://100.82.53.92:3773/"]) {
      enter(address, value);
      expect(address.value).toBe(value);
      expect(code.value).toBe("replacement-code");
    }

    const scannedLanUrl =
      "http://192.168.1.44:3773/pair#token=scan-code&peer=12D3KooWScanPeer&addr=%2Fip4%2F192.168.1.44%2Ftcp%2F4100%2Fp2p%2F12D3KooWScanPeer";
    harness.connectPress.mockClear().mockResolvedValueOnce({ ok: true, error: null });
    await act(async () => {
      harness.onBarcodeScanned?.({
        data: `covecode://pair?pairingUrl=${encodeURIComponent(scannedLanUrl)}`,
      });
    });
    expect(address.value).toBe("http://192.168.1.44:3773");
    expect(code.value).toBe("scan-code");
    expect(harness.connectPress).toHaveBeenCalledExactlyOnceWith(scannedLanUrl, undefined);
  } finally {
    act(() => root.unmount());
  }
});

it("prefills a valid peer-pinned route pairing URL in production and redeems only on explicit submit", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("__DEV__", false);
  harness.pendingConnectionError = null;
  harness.connectPress.mockClear().mockResolvedValueOnce({ ok: true, error: null });
  const peerId = "12D3KooW11111111111111111111111111111111111111111111";
  const pinnedLanUrl = `http://192.168.1.44:3773/pair#token=pinned-code&peer=${peerId}&addr=${encodeURIComponent(`/ip4/192.168.1.44/tcp/4100/p2p/${peerId}`)}`;
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    act(() =>
      root.render(
        <ConnectionsNewRouteScreen
          route={{ params: { pairingUrl: "http://192.168.1.44:3773/pair#token=unpinned" } }}
        />,
      ),
    );
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Address"]')!.value).toBe(
      "",
    );
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Code"]')!.value).toBe("");

    act(() =>
      root.render(<ConnectionsNewRouteScreen route={{ params: { pairingUrl: pinnedLanUrl } }} />),
    );
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Address"]')!.value).toBe(
      "http://192.168.1.44:3773",
    );
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Code"]')!.value).toBe(
      "pinned-code",
    );
    expect(harness.connectPress).not.toHaveBeenCalled();

    await act(async () => {
      harness.submitAction?.();
    });
    expect(harness.connectPress).toHaveBeenCalledExactlyOnceWith(pinnedLanUrl, undefined);
  } finally {
    act(() => root.unmount());
  }
});
