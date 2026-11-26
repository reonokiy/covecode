import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { HOOK_INBOX_MAX_BYTES, HOOK_INBOX_MAX_PER_HOOK, type HeldHook } from "./HookInboxStore.ts";
import { RelayDb } from "../db.ts";
import { ENVIRONMENT_UNREACHABLE_STATUSES, sendUpstream } from "./upstream.ts";

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

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const layerPostgres = Layer.effect(
  HookInbox,
  Effect.gen(function* () {
    const sql = (yield* RelayDb).$client;
    return HookInbox.of({
      hold: Effect.fn("relay.hook_inbox.hold")(function* ({ endpointKey, hook }) {
        const { body, ...request } = hook;
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              // Serialize admission so simultaneous requests cannot exceed the per-environment limits.
              yield* sql.unsafe("SELECT pg_advisory_xact_lock(42,hashtext($1))", [endpointKey]);
              const rows = yield* sql.unsafe(
                `
          INSERT INTO cove_held_hooks(endpoint_key,hook_key,delivery_id,request,body)
          SELECT $1,$2,$3,$4::jsonb,$5::bytea FROM cove_held_hooks
          WHERE endpoint_key=$1 AND expires_at>now()
          HAVING count(*)<$6 AND count(*) FILTER (WHERE hook_key=$2)<$7
            AND coalesce(sum(octet_length(body)),0)+octet_length($5::bytea)<=$8
          ON CONFLICT (delivery_id) DO NOTHING RETURNING seq`,
                [
                  endpointKey,
                  hook.hookKey,
                  hook.id,
                  encodeRequest(request),
                  body,
                  HOOK_INBOX_MAX_REQUESTS,
                  HOOK_INBOX_MAX_PER_HOOK,
                  HOOK_INBOX_MAX_BYTES,
                ],
              );
              return rows.length > 0;
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) => new HookInboxError({ operation: "hold", endpointKey, cause }),
            ),
          );
      }),
      wake: Effect.fn("relay.hook_inbox.wake")(function* ({ endpointKey }) {
        const rows = yield* sql
          .unsafe(
            "UPDATE cove_held_hooks SET available_at=now() WHERE endpoint_key=$1 AND expires_at>now() RETURNING seq",
            [endpointKey],
          )
          .pipe(
            Effect.mapError(
              (cause) => new HookInboxError({ operation: "wake", endpointKey, cause }),
            ),
          );
        return rows.length > 0;
      }),
      clear: Effect.fn("relay.hook_inbox.clear")(({ endpointKey }) =>
        sql.unsafe("DELETE FROM cove_held_hooks WHERE endpoint_key=$1", [endpointKey]).pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) => new HookInboxError({ operation: "clear", endpointKey, cause }),
          ),
        ),
      ),
    });
  }),
);

export const deliverOne = Effect.fn("relay.hook_inbox.deliver_one")(function* <E>(
  resolveTarget: (endpointKey: string) => Effect.Effect<string | null, E>,
) {
  const sql = (yield* RelayDb).$client;
  const [row] = yield* sql.unsafe<{
    seq: string;
    endpoint_key: string;
    attempt: number;
    request: Omit<HeldHook, "body">;
    body: Uint8Array;
  }>(`UPDATE cove_held_hooks SET lease_until=now()+interval '30 seconds',attempt=attempt+1
    WHERE seq=(SELECT j.seq FROM cove_held_hooks j
      WHERE j.available_at<=now() AND j.expires_at>now() AND (j.lease_until IS NULL OR j.lease_until<=now())
        AND NOT EXISTS (SELECT 1 FROM cove_held_hooks older WHERE older.endpoint_key=j.endpoint_key
          AND older.hook_key=j.hook_key AND older.seq<j.seq AND older.expires_at>now())
      ORDER BY j.available_at,j.seq LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING seq,endpoint_key,attempt,request,body`);
  if (!row) return false;
  const target = yield* resolveTarget(row.endpoint_key);
  let finished = target === null;
  if (target !== null) {
    const result = yield* sendUpstream(target, { ...row.request, body: row.body }).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    finished =
      Option.isSome(result) &&
      !ENVIRONMENT_UNREACHABLE_STATUSES.has(result.value.status) &&
      result.value.status !== 429;
  }
  if (finished) {
    yield* sql.unsafe("DELETE FROM cove_held_hooks WHERE seq=$1 AND attempt=$2", [
      row.seq,
      row.attempt,
    ]);
  } else {
    yield* sql.unsafe(
      `UPDATE cove_held_hooks SET lease_until=NULL, available_at=now()+interval '30 seconds'
      WHERE seq=$1 AND attempt=$2`,
      [row.seq, row.attempt],
    );
  }
  return true;
});
