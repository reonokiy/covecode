import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import type * as FcmDeliveries from "./FcmDeliveries.ts";

export class FcmDeliveryQueueSender extends Context.Service<
  FcmDeliveryQueueSender,
  {
    readonly send: (
      body: FcmDeliveries.FcmDeliveryJob,
    ) => Effect.Effect<void, ApnsDeliveryQueue.DeliveryQueueTransportError>;
  }
>()("t3code-relay/agentActivity/FcmDeliveryQueueSender") {}

export const layerInProcess = (
  send: (
    body: FcmDeliveries.FcmDeliveryJob,
  ) => Effect.Effect<void, ApnsDeliveryQueue.DeliveryQueueTransportError>,
) =>
  Layer.succeed(
    FcmDeliveryQueueSender,
    FcmDeliveryQueueSender.of({
      send,
    }),
  );

export const layerNoop = layerInProcess(() => Effect.void);
