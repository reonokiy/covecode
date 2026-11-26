import type { LanPeer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { msg } from "gt-i18n";
import { translatableDetail } from "../errors/translatable.ts";
import type { LanPeerTransport } from "../relay/environmentTunnel.ts";
import { ConnectionBlockedError, ConnectionTransientError } from "./model.ts";

export const openLanPeer = Effect.fn("clientRuntime.connection.openLanPeer")(function* (
  peer: LanPeer & { readonly discoveryBaseUrl: string },
  platform: LanPeerTransport["Service"] | undefined,
  mode: "pair" | "reconnect",
) {
  if (!platform)
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      ...translatableDetail(msg("Encrypted environment transport is unavailable.")),
    });
  return yield* Effect.tryPromise({
    try: () => (mode === "pair" ? platform.openPairing(peer) : platform.prepare(peer)),
    catch: (cause) =>
      new ConnectionTransientError({
        reason: "network",
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
  });
});
