import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as RelayDb from "../db.ts";
import { DeliveryQueueTransportError } from "./ApnsDeliveryQueue.ts";

const encodePayload = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type Channel = "apns" | "fcm";

export const enqueue = Effect.fn("cp.push.enqueue")(function* (
  channel: Channel,
  deviceId: string,
  payload: unknown,
) {
  const db = yield* RelayDb.RelayDb;
  yield* db.$client
    .unsafe("INSERT INTO cove_push_jobs(channel,device_id,payload) VALUES ($1,$2,$3::jsonb)", [
      channel,
      deviceId,
      encodePayload(payload),
    ])
    .pipe(Effect.mapError((cause) => new DeliveryQueueTransportError({ cause })));
});

export const consumeOne = Effect.fn("cp.push.consume")(function* <A, E>(
  channel: Channel,
  deliver: (payload: unknown) => Effect.Effect<A, E>,
) {
  const db = yield* RelayDb.RelayDb;
  const [job] = yield* db.$client.unsafe<{ id: string; attempts: number; payload: unknown }>(
    `
    UPDATE cove_push_jobs SET attempts=attempts+1, available_at=now()+interval '90 seconds'
    WHERE id=(SELECT j.id FROM cove_push_jobs j WHERE channel=$1 AND available_at<=now()
      AND NOT EXISTS (SELECT 1 FROM cove_push_jobs older
        WHERE older.channel=j.channel AND older.device_id=j.device_id AND older.id<j.id)
      ORDER BY j.id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id,attempts,payload`,
    [channel],
  );
  if (!job) return false;
  const delivered = yield* deliver(job.payload).pipe(
    Effect.timeout("60 seconds"),
    Effect.as(true),
    Effect.catchCause(() =>
      Effect.logWarning("Push delivery failed", {
        channel,
        jobId: job.id,
        attempt: job.attempts,
      }).pipe(Effect.as(false)),
    ),
  );
  if (delivered || job.attempts >= 5) {
    yield* db.$client.unsafe("DELETE FROM cove_push_jobs WHERE id=$1 AND attempts=$2", [
      job.id,
      job.attempts,
    ]);
  } else {
    yield* db.$client.unsafe(
      "UPDATE cove_push_jobs SET available_at=now()+$3 * interval '1 second' WHERE id=$1 AND attempts=$2",
      [job.id, job.attempts, 15 * 2 ** job.attempts],
    );
  }
  return true;
});

export const worker = <A, E>(
  channel: Channel,
  deliver: (payload: unknown) => Effect.Effect<A, E>,
) =>
  consumeOne(channel, deliver).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Push queue unavailable", { channel, cause }).pipe(Effect.as(false)),
    ),
    Effect.flatMap((worked) => (worked ? Effect.void : Effect.sleep("1 second"))),
    Effect.forever,
  );
