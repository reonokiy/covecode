import { retryCloudAuth, signInToCloud, useCloudAuth } from "./oidcAuth";

/** Opens the OIDC sign-in redirect, or retries loading the control plane config when that failed. */
export function useCloudAuthPrompt() {
  const { loadFailed } = useCloudAuth();
  return { openAuthPrompt: loadFailed ? retryCloudAuth : signInToCloud };
}
