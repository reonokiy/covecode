import { useSyncExternalStore } from "react";

import {
  getCloudAuthSnapshot,
  getMobileCloudToken,
  signInToMobileCloud,
  signOutOfMobileCloud,
  subscribeToCloudAuth,
} from "./mobileOidcAuth";

/** Same field names as Clerk's useAuth/useUser so call sites only need import changes. */
export function useMobileCloudAuth() {
  const snap = useSyncExternalStore(subscribeToCloudAuth, getCloudAuthSnapshot);
  return {
    isLoaded: snap.status !== "loading",
    isSignedIn: snap.status === "loading" ? undefined : snap.status === "signed-in",
    userId: snap.status === "signed-in" ? snap.user.id : null,
    user: snap.status === "signed-in" ? snap.user : null,
    getToken: getMobileCloudToken,
    signIn: signInToMobileCloud,
    signOut: signOutOfMobileCloud,
  };
}
