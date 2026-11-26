import { getRandomValues } from "expo-crypto";
import {
  createOidcSession,
  controlPlaneSessionKey,
  discoverControlPlane,
  type OidcSession,
  type OidcSessionSnapshot,
  type OidcSessionStorage,
  type StoredOidcSession,
} from "@t3tools/client-runtime/relay";
import { reloadAppAsync } from "expo";
import * as WebBrowser from "expo-web-browser";
import * as SecureStore from "expo-secure-store";

import {
  loadControlPlaneSelection,
  rememberControlPlane,
  resolveCloudPublicConfig,
} from "./publicConfig";

const storage = (key: string): OidcSessionStorage => ({
  load: async () => {
    try {
      const raw = await SecureStore.getItemAsync(key);
      return raw === null ? null : (JSON.parse(raw) as StoredOidcSession);
    } catch {
      return null;
    }
  },
  save: async (value) => {
    if (value === null) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, JSON.stringify(value));
  },
});

let session: OidcSession | null = null;
let snapshot: OidcSessionSnapshot = { status: "loading" };
let starting: Promise<OidcSession | null> | null = null;
const listeners = new Set<() => void>();

const publish = (next: OidcSessionSnapshot) => {
  snapshot = next;
  for (const listener of listeners) listener();
};

export function startMobileCloudAuth(): Promise<OidcSession | null> {
  starting ??= (async () => {
    try {
      await loadControlPlaneSelection();
      const { relay } = resolveCloudPublicConfig();
      if (!relay.url) {
        publish({ status: "signed-out" });
        return null;
      }
      const { oidc } = await discoverControlPlane(relay.url, fetch);
      const next = createOidcSession({
        config: oidc,
        randomValues: getRandomValues,
        storage: storage(controlPlaneSessionKey(relay.url)),
      });
      next.subscribe(publish);
      await next.restore();
      session = next;
      return next;
    } catch {
      starting = null;
      publish({ status: "signed-out" });
      return null;
    }
  })();
  return starting;
}

export async function signInToMobileCloud(redirectUri: string, address: string): Promise<void> {
  await loadControlPlaneSelection();
  const { origin, oidc } = await discoverControlPlane(address, fetch);
  const target = createOidcSession({
    config: oidc,
    randomValues: getRandomValues,
    storage: storage(controlPlaneSessionKey(origin)),
  });
  const { url, pending } = await target.beginAuthorization(redirectUri);
  const result = await WebBrowser.openAuthSessionAsync(url, redirectUri);
  if (result.type !== "success") return;
  await target.completeAuthorization(result.url, pending);
  await rememberControlPlane(origin);
  await reloadAppAsync();
}

export async function signOutOfMobileCloud(): Promise<void> {
  await session?.signOut();
}

export async function getMobileCloudToken(): Promise<string | null> {
  const target = await startMobileCloudAuth();
  return target === null ? null : target.getToken();
}

export function getCloudAuthSnapshot(): OidcSessionSnapshot {
  return snapshot;
}

export function subscribeToCloudAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
