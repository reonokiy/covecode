import * as NodeModule from "node:module";
import type { NavigationState, PartialState } from "@react-navigation/native";
import { expect, it, vi } from "vite-plus/test";

const requireFromNative = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const requireFromCore = NodeModule.createRequire(
  requireFromNative.resolve("@react-navigation/core/package.json"),
);
const { getActionFromState, getStateFromPath } = requireFromNative("@react-navigation/core") as {
  readonly getActionFromState: typeof import("@react-navigation/native").getActionFromState;
  readonly getStateFromPath: typeof import("@react-navigation/native").getStateFromPath;
};
const { StackRouter } = requireFromCore("@react-navigation/routers") as {
  readonly StackRouter: typeof import("@react-navigation/native").StackRouter;
};

const harness = vi.hoisted(() => ({
  pair: vi.fn(),
  goBack: vi.fn(),
  dispatch: vi.fn(),
  columns: false,
  // The root stack the form sits on when pairing succeeds.
  rootState: {
    key: "root",
    index: 2,
    routes: [
      { key: "home", name: "Home" },
      { key: "settings", name: "Settings" },
      { key: "new", name: "SettingsEnvironmentNew" },
    ],
  },
  // Navigation that is not ready yet holds callbacks here until the test flushes them.
  deferred: null as Array<() => void> | null,
}));

vi.mock("@react-navigation/native", () => ({
  StackActions: { replace: vi.fn() },
  CommonActions: {
    replaceParams: (params: object) => ({ type: "REPLACE_PARAMS", payload: { params } }),
  },
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  pairEnvironment: harness.pair,
}));
vi.mock("../layout/workspace/workspace-selection-store", () => ({
  workspaceHasColumns: () => harness.columns,
}));
vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: {
    getCurrentRoute: () => harness.rootState.routes[harness.rootState.index],
    getRootState: () => harness.rootState,
    getState: () => harness.rootState,
    getParent: () => undefined,
    canGoBack: () => true,
    goBack: harness.goBack,
    dispatch: harness.dispatch,
  },
  whenRootNavigationReady: (navigate: () => void) => {
    if (harness.deferred) harness.deferred.push(navigate);
    else navigate();
  },
}));

import { appAtomRegistry } from "../../state/atom-registry";
import {
  autoConnectReport,
  devAutoConnectAttemptAtom,
  pairingFormLinkAction,
  startDevAutoConnect,
  withoutPairingTarget,
} from "./devAutoConnect";

const PAIRING_URL = "http://192.168.1.10:3773/pair#token=abc";
const VALID_PEER_ID = "12D3KooW11111111111111111111111111111111111111111111";
const PINNED_PAIRING_URL = `http://192.168.1.10:3773/pair#token=abc&peer=${VALID_PEER_ID}&addr=${encodeURIComponent(`/ip4/192.168.1.10/tcp/4100/p2p/${VALID_PEER_ID}`)}`;

function settingsLink(params: object): PartialState<NavigationState> {
  return {
    routes: [
      { name: "Home" },
      { name: "Settings", state: { routes: [{ name: "SettingsEnvironmentNew", params }] } },
    ],
  };
}

it("pairs from a nested settings link once, reports failure, and closes the form on success", async () => {
  vi.stubGlobal("__DEV__", true);
  const failed = Promise.withResolvers<{ ok: boolean; error: string | null }>();
  harness.pair.mockReturnValueOnce(failed.promise);

  const state = settingsLink({ pairingUrl: ` ${PAIRING_URL} `, autoConnect: "1" });
  expect(startDevAutoConnect(state)).toBe(state);
  expect(harness.pair).toHaveBeenCalledExactlyOnceWith(PAIRING_URL);
  expect(appAtomRegistry.get(devAutoConnectAttemptAtom)).toEqual({
    pairingUrl: PAIRING_URL,
    status: "connecting",
  });

  failed.resolve({ ok: false, error: "Pairing code expired." });
  await failed.promise;
  await Promise.resolve();
  expect(appAtomRegistry.get(devAutoConnectAttemptAtom)).toEqual({
    pairingUrl: PAIRING_URL,
    status: "failed",
    error: "Pairing code expired.",
  });
  expect(harness.goBack).not.toHaveBeenCalled();

  const succeeded = Promise.withResolvers<{ ok: boolean; error: string | null }>();
  harness.pair.mockReturnValueOnce(succeeded.promise);
  startDevAutoConnect(settingsLink({ pairingUrl: PAIRING_URL, autoConnect: "true" }));
  succeeded.resolve({ ok: true, error: null });
  await succeeded.promise;
  await Promise.resolve();
  expect(appAtomRegistry.get(devAutoConnectAttemptAtom)).toBeNull();
  expect(harness.goBack).toHaveBeenCalledOnce();
});

it("only prefills without the flag, and ignores the flag in production builds", () => {
  harness.pair.mockClear();
  vi.stubGlobal("__DEV__", true);
  startDevAutoConnect(settingsLink({ pairingUrl: PAIRING_URL }));
  vi.stubGlobal("__DEV__", false);
  startDevAutoConnect(settingsLink({ pairingUrl: PAIRING_URL, autoConnect: "1" }));
  expect(harness.pair).not.toHaveBeenCalled();
});

it("forgets a failed auto-connect once the form is opened again without the flag", async () => {
  vi.stubGlobal("__DEV__", true);
  const failed = Promise.withResolvers<{ ok: boolean; error: string | null }>();
  harness.pair.mockReturnValueOnce(failed.promise);
  startDevAutoConnect(settingsLink({ pairingUrl: PAIRING_URL, autoConnect: "1" }));
  failed.resolve({ ok: false, error: "Pairing code expired." });
  await failed.promise;
  await Promise.resolve();
  expect(appAtomRegistry.get(devAutoConnectAttemptAtom)).toMatchObject({ status: "failed" });

  startDevAutoConnect(settingsLink({ pairingUrl: PAIRING_URL }));
  expect(appAtomRegistry.get(devAutoConnectAttemptAtom)).toBeNull();
});

it("drops the result of a pairing that a later link superseded", async () => {
  vi.stubGlobal("__DEV__", true);
  const stale = Promise.withResolvers<{ ok: boolean; error: string | null }>();
  harness.pair.mockReturnValueOnce(stale.promise);
  startDevAutoConnect(settingsLink({ pairingUrl: PAIRING_URL, autoConnect: "1" }));
  startDevAutoConnect(settingsLink({ pairingUrl: PAIRING_URL }));

  stale.resolve({ ok: false, error: "Pairing code expired." });
  await stale.promise;
  await Promise.resolve();
  expect(appAtomRegistry.get(devAutoConnectAttemptAtom)).toBeNull();
});

it("keeps Connect busy while the auto-connect runs, even after the user edits the form", () => {
  const connecting = { pairingUrl: PAIRING_URL, status: "connecting" } as const;
  expect(autoConnectReport(connecting, PAIRING_URL, true)).toEqual({
    connecting: true,
    error: null,
  });
  const failed = { pairingUrl: PAIRING_URL, status: "failed", error: "Expired." } as const;
  expect(autoConnectReport(failed, PAIRING_URL, false)).toEqual({
    connecting: false,
    error: "Expired.",
  });
  expect(autoConnectReport(failed, PAIRING_URL, true).error).toBeNull();
  expect(autoConnectReport(connecting, "http://other/pair#token=x", false).connecting).toBe(false);
});

async function pairSuccessfully(link: PartialState<NavigationState>) {
  const succeeded = Promise.withResolvers<{ ok: boolean; error: string | null }>();
  harness.pair.mockReturnValueOnce(succeeded.promise);
  startDevAutoConnect(link);
  succeeded.resolve({ ok: true, error: null });
  await succeeded.promise;
  await Promise.resolve();
}

it("on columns, a successful settings link shows Environments instead of an empty detail", async () => {
  vi.stubGlobal("__DEV__", true);
  harness.goBack.mockClear();
  harness.dispatch.mockClear();
  harness.columns = true;
  await pairSuccessfully(settingsLink({ pairingUrl: PAIRING_URL, autoConnect: "1" }));
  harness.columns = false;

  expect(harness.goBack).not.toHaveBeenCalled();
  expect(harness.dispatch).toHaveBeenCalledExactlyOnceWith({
    type: "RESET",
    target: "root",
    payload: expect.objectContaining({
      index: 2,
      routes: [
        { key: "home", name: "Home" },
        { key: "settings", name: "Settings" },
        { name: "SettingsEnvironments", params: undefined },
      ],
    }),
  });
});

it("a success that waited for navigation leaves a newer link's form open", async () => {
  vi.stubGlobal("__DEV__", true);
  harness.goBack.mockClear();
  harness.dispatch.mockClear();
  harness.deferred = [];
  await pairSuccessfully(settingsLink({ pairingUrl: PAIRING_URL, autoConnect: "1" }));
  startDevAutoConnect(settingsLink({ pairingUrl: "http://192.168.1.11:3773/pair#token=def" }));

  const deferred = harness.deferred;
  harness.deferred = null;
  for (const navigate of deferred) navigate();
  expect(harness.goBack).not.toHaveBeenCalled();
  expect(harness.dispatch).not.toHaveBeenCalled();
});

it("a pairing link fills the pairing form already on screen instead of stacking a second one", () => {
  const linking = {
    initialRouteName: "Home",
    screens: {
      Home: "",
      Settings: "settings",
      SettingsEnvironmentNew: "settings/environment-new",
      ConnectionsNew: "connections/new",
    },
  };
  const router = StackRouter({});
  const options = {
    routeNames: Object.keys(linking.screens),
    routeParamList: {},
    routeGetIdList: {},
  };
  // Settings > Environments > Add environment, as the user opened it.
  const open = router.getRehydratedState(
    {
      index: 2,
      routes: [{ name: "Home" }, { name: "Settings" }, { name: "SettingsEnvironmentNew" }],
    },
    options,
  );
  const link = getStateFromPath(
    `connections/new?pairingUrl=${encodeURIComponent(PAIRING_URL)}`,
    linking,
  )!;
  const action = pairingFormLinkAction(link, open) ?? getActionFromState(link, linking)!;
  const next = router.getStateForAction(open, { target: open.key, ...action }, options);

  expect(next?.routes.map((route) => route.name)).toEqual([
    "Home",
    "Settings",
    "SettingsEnvironmentNew",
  ]);
  expect(next?.routes.at(-1)).toMatchObject({
    key: open.routes[2]!.key,
    params: { pairingUrl: PAIRING_URL },
  });
});

it("routes a valid peer-pinned pair app link to the pairing form without auto-connecting", () => {
  harness.pair.mockClear();
  const linking = {
    initialRouteName: "Home",
    screens: {
      Home: "",
      Settings: "settings",
      SettingsEnvironmentNew: "settings/environment-new",
      ConnectionsNew: { path: "connections/new", alias: ["pair"] },
    },
  };
  const router = StackRouter({});
  const options = {
    routeNames: Object.keys(linking.screens),
    routeParamList: {},
    routeGetIdList: {},
  };

  vi.stubGlobal("__DEV__", false);
  const coldStartPath = `pair?pairingUrl=${encodeURIComponent(PINNED_PAIRING_URL)}&autoConnect=1&routeFor=env-1`;
  const coldStartState = startDevAutoConnect(
    withoutPairingTarget(getStateFromPath(coldStartPath, linking), coldStartPath),
  );
  expect(coldStartState?.routes.map((route) => route.name)).toEqual(["Home", "ConnectionsNew"]);
  expect(coldStartState?.routes.at(-1)?.params).toEqual({ pairingUrl: PINNED_PAIRING_URL });
  expect(harness.pair).not.toHaveBeenCalled();

  // Foreground when another screen is active opens ConnectionsNew with the pinned URL.
  const homeOpen = router.getRehydratedState({ index: 0, routes: [{ name: "Home" }] }, options);
  const foregroundAction =
    pairingFormLinkAction(coldStartState!, homeOpen) ??
    getActionFromState(coldStartState!, linking)!;
  const foregroundNext = router.getStateForAction(
    homeOpen,
    { target: homeOpen.key, ...foregroundAction },
    options,
  );
  expect(foregroundNext?.routes.map((route) => route.name)).toEqual(["Home", "ConnectionsNew"]);
  expect(foregroundNext?.routes.at(-1)?.params).toEqual({ pairingUrl: PINNED_PAIRING_URL });

  // Foreground when the pairing form is already open updates it in place.
  const formOpen = router.getRehydratedState(
    { index: 1, routes: [{ name: "Home" }, { name: "ConnectionsNew" }] },
    options,
  );
  const inPlaceAction =
    pairingFormLinkAction(coldStartState!, formOpen) ??
    getActionFromState(coldStartState!, linking)!;
  const inPlaceNext = router.getStateForAction(
    formOpen,
    { target: formOpen.key, ...inPlaceAction },
    options,
  );
  expect(inPlaceNext?.routes.map((route) => route.name)).toEqual(["Home", "ConnectionsNew"]);
  expect(inPlaceNext?.routes.at(-1)).toMatchObject({
    key: formOpen.routes[1]!.key,
    params: { pairingUrl: PINNED_PAIRING_URL },
  });

  // Unpinned or invalid pair links are rejected.
  const unpinnedPath = `pair?pairingUrl=${encodeURIComponent(PAIRING_URL)}`;
  expect(
    withoutPairingTarget(getStateFromPath(unpinnedPath, linking), unpinnedPath),
  ).toBeUndefined();
});
