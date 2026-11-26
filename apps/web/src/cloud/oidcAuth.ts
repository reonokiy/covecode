import {
  createOidcSession,
  controlPlaneSessionKey,
  discoverControlPlane,
  type OidcSession,
  type OidcSessionSnapshot,
  type OidcSessionStorage,
  type PendingOidcAuthorization,
  type StoredOidcSession,
} from "@t3tools/client-runtime/relay";
import { openControlPlaneDialog } from "./controlPlanePrompt";
import { useSyncExternalStore } from "react";

import { rememberControlPlane, resolveCloudPublicConfig } from "./publicConfig";

const PENDING_KEY = "cove.oidc.pending";

type StoredPending = PendingOidcAuthorization & {
  readonly returnTo: string;
  readonly controlPlane: string;
};
export type CloudAuthSnapshot = OidcSessionSnapshot | { readonly status: "unavailable" };

const storage = (key: string): OidcSessionStorage => ({
  load: async () => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? null : (JSON.parse(raw) as StoredOidcSession);
    } catch {
      return null;
    }
  },
  save: async (value) => {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage can be unavailable (private mode); the session then lasts until reload.
    }
  },
});

let session: OidcSession | null = null;
let snapshot: CloudAuthSnapshot = { status: "loading" };
let starting: Promise<OidcSession | null> | null = null;
const listeners = new Set<() => void>();

const publish = (next: CloudAuthSnapshot) => {
  snapshot = next;
  for (const listener of listeners) listener();
};

async function completeRedirect(target: OidcSession): Promise<void> {
  const url = new URL(window.location.href);
  const returned = url.searchParams.has("code") || url.searchParams.has("error");
  if (!returned || !url.searchParams.has("state")) return;
  const raw = window.sessionStorage.getItem(PENDING_KEY);
  if (raw === null) return;
  const pending = JSON.parse(raw) as StoredPending;
  if (
    pending.controlPlane !== resolveCloudPublicConfig().relayUrl ||
    pending.state !== url.searchParams.get("state")
  )
    return;
  window.sessionStorage.removeItem(PENDING_KEY);
  try {
    await target.completeAuthorization(url.toString(), pending);
  } finally {
    window.history.replaceState(null, "", pending.returnTo);
  }
}

/** Loads the OIDC config from the relay control plane once, restores the stored session and finishes a pending redirect. */
export function startCloudAuth(): Promise<OidcSession | null> {
  starting ??= (async () => {
    const { relayUrl } = resolveCloudPublicConfig();
    if (relayUrl === null) {
      publish({ status: "signed-out" });
      return null;
    }
    try {
      const { oidc } = await discoverControlPlane(relayUrl, fetch);
      const next = createOidcSession({
        config: oidc,
        storage: storage(controlPlaneSessionKey(relayUrl)),
      });
      next.subscribe(publish);
      await next.restore();
      await completeRedirect(next);
      session = next;
      return next;
    } catch {
      starting = null;
      publish({ status: "unavailable" });
      return null;
    }
  })();
  return starting;
}

export async function signInToCloud(address: string): Promise<void> {
  const { origin, oidc } = await discoverControlPlane(address, fetch);
  const target = createOidcSession({
    config: oidc,
    storage: storage(controlPlaneSessionKey(origin)),
  });
  const redirectUri = window.desktopBridge
    ? new URL("/auth/cove", window.location.href).href
    : window.location.origin + "/";
  const { url, pending } = await target.beginAuthorization(redirectUri);
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const stored: StoredPending = { ...pending, returnTo, controlPlane: origin };
  window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(stored));
  rememberControlPlane(origin);
  if (window.desktopBridge) {
    if (!(await window.desktopBridge.openExternal(url))) throw new Error("Could not open sign-in");
  } else window.location.assign(url);
}

export async function signOutOfCloud(): Promise<void> {
  await session?.signOut();
}

export async function getCloudToken(): Promise<string | null> {
  const target = await startCloudAuth();
  return target === null ? null : target.getToken();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Same field names as Clerk's `useAuth`, so call sites only change their import. */
export function useCloudAuth() {
  const current = useSyncExternalStore(subscribe, () => snapshot);
  return {
    isLoaded: current.status !== "loading",
    isSignedIn: current.status === "loading" ? undefined : current.status === "signed-in",
    userId: current.status === "signed-in" ? current.user.id : null,
    user: current.status === "signed-in" ? current.user : null,
    loadFailed: current.status === "unavailable",
    getToken: getCloudToken,
    signIn: openControlPlaneDialog,
    signOut: signOutOfCloud,
    retry: openControlPlaneDialog,
  };
}
