import type { ReactNode } from "react";
import { useEffect } from "react";

import { cloudAccountService, deactivateCloudRelayAccount } from "./cloudAccountService";
import { startMobileCloudAuth } from "./mobileOidcAuth";

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches the OIDC session to the cloud account service once the control-plane config has loaded
  useEffect(() => {
    let detach: (() => void) | null = null;
    let cancelled = false;
    void startMobileCloudAuth().then((sess) => {
      if (cancelled) return;
      if (sess === null) {
        deactivateCloudRelayAccount();
        return;
      }
      detach = cloudAccountService.attach(sess);
    });
    return () => {
      cancelled = true;
      detach?.();
    };
  }, []);

  return props.children;
}
