import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { HOOK_INBOX_MAX_BYTES, HOOK_INBOX_MAX_PER_HOOK, type HeldHook } from "./HookInboxStore.ts";
import { sendUpstream } from "./upstream.ts";

const HOOK_INBOX_MAX_REQUESTS = 1_000;

export class HookInboxError extends Schema.TaggedError<HookInboxError>()("HookInboxError", {
  operation: Schema.Literals(["hold", "wake", "clear"]),
  endpointKey: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Hook inbox '${this.operation}' failed for endpoint '${this.endpointKey}'`;
  }
}

export class HookInbox extends Context.Service<
  HookInbox,
  {
    /** False when the environment's inbox is full and nothing was stored. */
    readonly hold: (input: {
      readonly endpointKey: string;
      readonly baseUrl: string;
      readonly hook: HeldHook;
    }) => Effect.Effect<boolean, HookInboxError>;
    readonly wake: (input: {
      readonly endpointKey: string;
      readonly baseUrl: string;
    }) => Effect.Effect<boolean, HookInboxError>;
    readonly clear: (input: {
      readonly endpointKey: string;
    }) => Effect.Effect<void, HookInboxError>;
  }
>()("cove-cp/hooks/HookInbox") {}

export const layerNoop: Layer.Layer<HookInbox> = Layer.succeed(
  HookInbox,
  HookInbox.of({
    hold: Effect.fn("HookInbox.hold")(() => Effect.succeed(false)),
    wake: Effect.fn("HookInbox.wake")(() => Effect.succeed(false)),
    clear: Effect.fn("HookInbox.clear")(() => Effect.void),
  }),
);

interface EndpointInboxBucket {
  baseUrl: string;
  items: Array<HeldHook>;
  totalBytes: number;
  draining: boolean;
}

export const layerInProcess: Layer.Layer<HookInbox, never, HttpClient.HttpClient> = Layer.effect(
  HookInbox,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const buckets = new Map<string, EndpointInboxBucket>();

    const drainBucket = Effect.fn("relay.hook_inbox.drain_bucket")(function* (endpointKey: string) {
      const bucket = buckets.get(endpointKey);
      if (!bucket || bucket.draining) return;
      bucket.draining = true;
      try {
        while (bucket.items.length > 0) {
          const next = bucket.items[0];
          if (!next) break;
          const sent = yield* sendUpstream(bucket.baseUrl, next).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.map((response) => Option.isSome(response)),
            Effect.orElseSucceed(() => false),
          );
          if (!sent) {
            break;
          }
          bucket.items.shift();
          bucket.totalBytes = Math.max(0, bucket.totalBytes - next.body.byteLength);
        }
        if (bucket.items.length === 0) {
          buckets.delete(endpointKey);
        }
      } finally {
        bucket.draining = false;
      }
    });

    return HookInbox.of({
      hold: Effect.fn("relay.hook_inbox.hold")((input) =>
        Effect.sync(() => {
          let bucket = buckets.get(input.endpointKey);
          if (!bucket) {
            bucket = { baseUrl: input.baseUrl, items: [], totalBytes: 0, draining: false };
            buckets.set(input.endpointKey, bucket);
          }
          bucket.baseUrl = input.baseUrl;
          if (bucket.items.some((item) => item.id === input.hook.id)) {
            return false;
          }
          const perHookCount = bucket.items.filter(
            (item) => item.hookKey === input.hook.hookKey,
          ).length;
          if (
            bucket.items.length >= HOOK_INBOX_MAX_REQUESTS ||
            perHookCount >= HOOK_INBOX_MAX_PER_HOOK ||
            bucket.totalBytes + input.hook.body.byteLength > HOOK_INBOX_MAX_BYTES
          ) {
            return false;
          }
          bucket.items.push(input.hook);
          bucket.totalBytes += input.hook.body.byteLength;
          return true;
        }),
      ),
      wake: Effect.fn("relay.hook_inbox.wake")(function* (input) {
        const bucket = buckets.get(input.endpointKey);
        if (!bucket || bucket.items.length === 0) {
          return false;
        }
        bucket.baseUrl = input.baseUrl;
        yield* Effect.forkDetach(drainBucket(input.endpointKey));
        return true;
      }),
      clear: Effect.fn("relay.hook_inbox.clear")((input) =>
        Effect.sync(() => {
          buckets.delete(input.endpointKey);
        }),
      ),
    });
  }),
);
