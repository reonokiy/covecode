import type { RelayRegisteredEndpoint } from "@covecode/libp2p-tunnel";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { RelayDb } from "../db.ts";

export interface ReplicaRoute {
  readonly registration: RelayRegisteredEndpoint;
  readonly addresses: string[];
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export function makeReplicaDirectory(db: RelayDb["Service"], instanceId: string) {
  const sql = db.$client;
  const lock = Semaphore.makeUnsafe(1);
  const dirty = new Map<string, RelayRegisteredEndpoint | null>();
  let closed = false;

  const sync = Effect.fn("cp.replica.sync")(function* () {
    if (closed) return;
    const changes = new Map(dirty);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        // A newer boot of this same peer fences the old process out of the directory.
        const owned = yield* sql.unsafe(
          "UPDATE cove_relay_replicas SET expires_at=now()+interval '45 seconds' WHERE instance_id=$1 RETURNING instance_id",
          [instanceId],
        );
        if (!owned.length) return yield* Effect.die("Relay identity is owned by another instance");
        for (const [key, registration] of changes) {
          if (registration) {
            yield* sql.unsafe(
              `INSERT INTO cove_relay_routes VALUES ($1,$2,$3::jsonb)
             ON CONFLICT (endpoint_key,instance_id) DO UPDATE SET registration=excluded.registration`,
              [instanceId, key, encodeJson(registration)],
            );
          } else {
            yield* sql.unsafe(
              "DELETE FROM cove_relay_routes WHERE instance_id=$1 AND endpoint_key=$2",
              [instanceId, key],
            );
          }
        }
      }),
    );
    for (const [key, value] of changes) if (dirty.get(key) === value) dirty.delete(key);
  }, lock.withPermits(1));

  return {
    start: Effect.fn("cp.replica.start")(function* (peer: string, advertised: string[]) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe("DELETE FROM cove_relay_replicas WHERE relay_peer=$1", [peer]);
          yield* sql.unsafe(
            "INSERT INTO cove_relay_replicas VALUES ($1,$2,$3::jsonb,now() + interval '45 seconds')",
            [instanceId, peer, encodeJson(advertised)],
          );
        }),
      );
    }),
    heartbeat: sync,
    record: (key: string, registration: RelayRegisteredEndpoint | null) => {
      dirty.set(key, registration);
      return sync();
    },
    routes: Effect.fn("cp.replica.routes")(function* (keys: readonly string[]) {
      if (!keys.length) return [];
      return yield* sql.unsafe<ReplicaRoute>(
        `SELECT r.registration, n.addresses FROM cove_relay_routes r JOIN cove_relay_replicas n USING (instance_id)
         WHERE r.endpoint_key IN (SELECT jsonb_array_elements_text($1::jsonb)) AND n.expires_at > now()
         ORDER BY (r.registration->>'connectedAt')::bigint DESC, n.relay_peer`,
        [encodeJson(keys)],
      );
    }),
    stop: Effect.gen(function* () {
      closed = true;
      yield* sql.unsafe("DELETE FROM cove_relay_replicas WHERE instance_id=$1", [instanceId]);
    }).pipe(lock.withPermits(1)),
  };
}
