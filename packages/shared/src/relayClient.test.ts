import { describe, expect, it } from "@effect/vitest";
import type { RelayClientInstallProgressEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as RelayClient from "./relayClient.ts";

describe("RelayClient (built-in libp2p)", () => {
  it.effect("resolves and installs the built-in libp2p client without downloads", () =>
    Effect.gen(function* () {
      const client = yield* RelayClient.RelayClient;
      const resolved = yield* client.resolve;
      expect(resolved).toEqual({
        status: "available",
        executablePath: RelayClient.BUILTIN_RELAY_CLIENT_PATH,
        source: "managed",
        version: RelayClient.BUILTIN_RELAY_CLIENT_VERSION,
      });
      if (resolved.status !== "available") {
        throw new Error("Expected built-in relay client to be available");
      }
      expect(RelayClient.isPinnedManagedRelayClient(resolved)).toBe(true);

      const installed = yield* client.install;
      expect(installed).toEqual(resolved);

      const events: Array<RelayClientInstallProgressEvent> = [];
      const progressed = yield* client.installWithProgress((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      );
      expect(progressed).toEqual(resolved);
      expect(events).toEqual([{ type: "complete", status: resolved }]);
    }).pipe(Effect.provide(RelayClient.layerBuiltinLibp2p)),
  );
});
