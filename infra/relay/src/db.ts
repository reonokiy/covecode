import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient.PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  {
    readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"];
  }
>()("t3code-relay/db/RelayTransactions") {
  static readonly layer = Layer.effect(
    RelayTransactions,
    Effect.gen(function* () {
      const db = yield* RelayDb;
      return RelayTransactions.of({
        withTransaction: db.$client.withTransaction,
      });
    }),
  );
}

export const layerPostgres = (databaseUrl: Redacted.Redacted<string>) => {
  const pgLayer = PgClient.layer({ url: databaseUrl });
  const drizzleLayer = Layer.effect(
    RelayDb,
    PgDrizzle.makeWithDefaults().pipe(Effect.map((db) => RelayDb.of(db))),
  ).pipe(Layer.provideMerge(pgLayer));

  return Layer.mergeAll(drizzleLayer, RelayTransactions.layer.pipe(Layer.provide(drizzleLayer)));
};

export const applyPostgresMigrations = Effect.fn("relay.db.apply_postgres_migrations")(function* (
  migrationsDir: string,
) {
  const db = yield* RelayDb;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const exists = yield* fs.exists(migrationsDir);
  if (!exists) {
    return { applied: [] as string[] };
  }

  yield* db.$client.unsafe(
    "CREATE TABLE IF NOT EXISTS relay_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
  );

  const existingRows = yield* db.$client.unsafe<{ readonly name: string }>(
    "SELECT name FROM relay_migrations",
  );
  const appliedSet = new Set(existingRows.map((row) => row.name));

  const entries = yield* fs.readDirectory(migrationsDir);
  const sorted = [...entries].toSorted();
  const newlyApplied: string[] = [];

  for (const folder of sorted) {
    if (appliedSet.has(folder)) continue;
    const sqlPath = path.join(migrationsDir, folder, "migration.sql");
    if (!(yield* fs.exists(sqlPath))) continue;

    const sqlText = yield* fs.readFileString(sqlPath);
    const statements = sqlText
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

    yield* db.$client.withTransaction(
      Effect.gen(function* () {
        for (const statement of statements) {
          yield* db.$client.unsafe(statement);
        }
        yield* db.$client.unsafe(
          "INSERT INTO relay_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
          [folder],
        );
      }),
    );
    newlyApplied.push(folder);
  }

  return { applied: newlyApplied };
});
