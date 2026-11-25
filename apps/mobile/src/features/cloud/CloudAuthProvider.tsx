import type { ReactNode } from "react";
import { useEffect } from "react";

import { cloudAccountService, deactivateCloudRelayAccount } from "./cloudAccountService";
import { hasCloudPublicConfig } from "./publicConfig";
import { startMobileCloudAuth } from "./mobileOidcAuth";

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches the OIDC session to the cloud account service once the control-plane config has loaded
  useEffect(() => {
    if (!hasCloudPublicConfig()) {
      deactivateCloudRelayAccount();
      return;
    }
    let detach: (() => void) | null = null;
    let cancelled = false;
    void startMobileCloudAuth().then((sess) => {
      if (sess === null || cancelled) return;
      detach = cloudAccountService.attach(sess);
    });
    return () => {
      cancelled = true;
      detach?.();
    };
  }, []);

  return props.children;
}
