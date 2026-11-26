import { useCloudAuth } from "./oidcAuth";

export function useCloudAuthPrompt() {
  const { signIn } = useCloudAuth();
  return { openAuthPrompt: signIn };
}
