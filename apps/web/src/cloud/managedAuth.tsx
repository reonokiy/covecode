import {
  createCloudAccountService,
  ManagedRelay,
  setManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect, type ReactNode } from "react";

import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { startCloudAuth } from "./oidcAuth";

export function deactivateManagedRelayAuthentication(): void {
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateManagedRelayAuthentication(
  accountId: string,
  readClerkToken: () => Promise<string | null>,
): void {
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readClerkToken,
  });
}

type CloudSession = NonNullable<Awaited<ReturnType<typeof startCloudAuth>>>;

// A failed route removal fails the switch, so the next account never activates over the old routes.
async function cleanUpManagedRelayAccount(): Promise<void> {
  const [removal, tokenReset] = await Promise.all([
    runAtomCommand(appAtomRegistry, environmentCatalog.removeRelayEnvironments, undefined, {
      reportFailure: false,
      reportDefect: false,
    }),
    settleAsyncResult(() =>
      runtime.runPromiseExit(
        ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
      ),
    ),
  ]);
  reportAtomCommandResult(tokenReset, { label: "cloud account cleanup" });
  if (removal._tag !== "Success") throw squashAtomCommandFailure(removal);
}

const managedRelayAccountService = createCloudAccountService<CloudSession>({
  deactivate: deactivateManagedRelayAuthentication,
  detach: deactivateManagedRelayAuthentication,
  cleanUp: cleanUpManagedRelayAccount,
  activate: ({ source, accountId }) =>
    activateManagedRelayAuthentication(accountId, source.getToken),
});

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches the OIDC session to the managed relay account service for the provider's lifetime
  useEffect(() => {
    let detach: (() => void) | null = null;
    let cancelled = false;
    void startCloudAuth().then((session) => {
      if (session === null || cancelled) return;
      detach = managedRelayAccountService.attach(session);
    });
    return () => {
      cancelled = true;
      detach?.();
    };
  }, []);
  return children;
}
