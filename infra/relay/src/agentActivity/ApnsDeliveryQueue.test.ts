import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayConfiguration from "../Config.ts";
import { makeTestRelayConfiguration } from "../testConfig.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";

const config = makeTestRelayConfiguration({
  relayIssuer: "https://relay.example.com",
});

describe("ApnsDeliveryQueue", () => {
  it.effect("signs and dispatches APNs delivery jobs through the in-process sender", () => {
    const sent: unknown[] = [];
    const layer = ApnsDeliveryQueue.layerInProcess((body) =>
      Effect.sync(() => {
        sent.push(body);
      }),
    ).pipe(Layer.provide(NodeCryptoLayer.layer), Layer.provide(RelayConfiguration.layer(config)));

    return Effect.gen(function* () {
      const queue = yield* ApnsDeliveryQueue.ApnsDeliveryQueue;
      yield* queue.enqueuePushNotification({
        userId: "user-1",
        deviceId: "device-1",
        token: "push-token",
        notification: {
          title: "Thread",
          body: "Input: Project",
          environmentId: "env-1",
          threadId: "thread-1",
          deepLink: "/threads/env-1/thread-1",
        },
      });

      expect(sent).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
});
