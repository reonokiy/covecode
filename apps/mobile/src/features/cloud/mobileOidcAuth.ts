import {
  createOidcSession,
  type OidcSession,
  type OidcSessionSnapshot,
  type OidcSessionStorage,
  type StoredOidcSession,
} from "@t3tools/client-runtime/relay";
import { RelayControlPlanePublicConfig } from "@t3tools/contracts/relay";
import * as WebBrowser from "expo-web-browser";
import * as SecureStore from "expo-secure-store";
import * as Schema from "effect/Schema";

import { resolveCloudPublicConfig } from "./publicConfig";

const SESSION_KEY = "cove.oidc.session";
const decodeControlPlane = Schema.decodeUnknownSync(RelayControlPlanePublicConfig);

const storage: OidcSessionStorage = {
  load: async () => {
    try {
      const raw = await SecureStore.getItemAsync(SESSION_KEY);
      return raw === null ? null : (JSON.parse(raw) as StoredOidcSession);
    } catch {
      return null;
    }
  },
  save: async (value) => {
    try {
      if (value === null) await SecureStore.deleteItemAsync(SESSION_KEY);
      else await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(value));
    } catch {
      // Secure store can be unavailable on simulators; skip persisting.
    }
  },
};

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
    const { relay } = resolveCloudPublicConfig();
    if (relay.url === null) {
      publish({ status: "signed-out" });
      return null;
    }
    try {
      const response = await fetch(new URL("/.well-known/cove-control-plane", relay.url));
      if (!response.ok) throw new Error(`Control plane answered ${response.status}`);
      const { oidc } = decodeControlPlane(await response.json());
      if (oidc === null) throw new Error("This control plane has no OIDC configuration.");
      const next = createOidcSession({ config: oidc, storage });
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

export async function signInToMobileCloud(redirectUri: string): Promise<void> {
  const target = await startMobileCloudAuth();
  if (target === null) return;
  const { url, pending } = await target.beginAuthorization(redirectUri);
  const result = await WebBrowser.openAuthSessionAsync(url, redirectUri);
  if (result.type !== "success") return;
  await target.completeAuthorization(result.url, pending);
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
