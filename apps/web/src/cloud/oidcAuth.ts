import {
  createOidcSession,
  type OidcSession,
  type OidcSessionSnapshot,
  type OidcSessionStorage,
  type PendingOidcAuthorization,
  type StoredOidcSession,
} from "@t3tools/client-runtime/relay";
import { RelayControlPlanePublicConfig } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import { resolveCloudPublicConfig } from "./publicConfig";

const SESSION_KEY = "cove.oidc.session";
const PENDING_KEY = "cove.oidc.pending";

type StoredPending = PendingOidcAuthorization & { readonly returnTo: string };
export type CloudAuthSnapshot = OidcSessionSnapshot | { readonly status: "unavailable" };

const decodeControlPlane = Schema.decodeUnknownSync(RelayControlPlanePublicConfig);

const storage: OidcSessionStorage = {
  load: async () => {
    try {
      const raw = window.localStorage.getItem(SESSION_KEY);
      return raw === null ? null : (JSON.parse(raw) as StoredOidcSession);
    } catch {
      return null;
    }
  },
  save: async (value) => {
    try {
      if (value === null) window.localStorage.removeItem(SESSION_KEY);
      else window.localStorage.setItem(SESSION_KEY, JSON.stringify(value));
    } catch {
      // Storage can be unavailable (private mode); the session then lasts until reload.
    }
  },
};

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
  window.sessionStorage.removeItem(PENDING_KEY);
  const pending = JSON.parse(raw) as StoredPending;
  await target.completeAuthorization(url.toString(), pending).catch(() => undefined);
  window.history.replaceState(null, "", pending.returnTo);
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
      const response = await fetch(new URL("/.well-known/cove-control-plane", relayUrl));
      if (!response.ok) throw new Error(`Control plane answered ${response.status}`);
      const { oidc } = decodeControlPlane(await response.json());
      if (oidc === null) throw new Error("This control plane has no OIDC configuration.");
      const next = createOidcSession({ config: oidc, storage });
      next.subscribe(publish);
      await next.restore();
      session = next;
      await completeRedirect(next).catch(() => undefined);
      return next;
    } catch {
      starting = null;
      publish({ status: "unavailable" });
      return null;
    }
  })();
  return starting;
}

export function retryCloudAuth(): void {
  publish({ status: "loading" });
  void startCloudAuth();
}

export async function signInToCloud(): Promise<void> {
  const target = await startCloudAuth();
  if (target === null) return;
  const { url, pending } = await target.beginAuthorization(`${window.location.origin}/`);
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const stored: StoredPending = { ...pending, returnTo };
  window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(stored));
  window.location.assign(url);
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
    signIn: signInToCloud,
    signOut: signOutOfCloud,
    retry: retryCloudAuth,
  };
}
