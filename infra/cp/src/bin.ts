import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

import type * as RelayConfiguration from "./Config.ts";
import * as RelayDb from "./db.ts";
import { startControlPlaneServer } from "./server.ts";

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseCommaList(
  value: string | undefined,
  fallback: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const raw = optionalEnv(value);
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parsePort(value: string | undefined, fallback: number): number {
  const raw = optionalEnv(value);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid PORT value '${raw}'`);
  }
  return parsed;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  const raw = optionalEnv(value);
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid integer value '${raw}'`);
  }
  return parsed;
}

function readOidcFromEnv(
  env: NodeJS.ProcessEnv,
): RelayConfiguration.OidcProviderConfiguration | null {
  const issuer = optionalEnv(env["COVE_CP_OIDC_ISSUER"]);
  const clientId = optionalEnv(env["COVE_CP_OIDC_CLIENT_ID"]);
  if (!issuer || !clientId) {
    return null;
  }
  const jwksUri = optionalEnv(env["COVE_CP_OIDC_JWKS_URI"]);
  const audience = optionalEnv(env["COVE_CP_OIDC_AUDIENCE"]);
  const scopes = parseCommaList(env["COVE_CP_OIDC_SCOPES"], ["openid", "profile", "email"]);
  return {
    issuer,
    clientId,
    scopes,
    ...(jwksUri !== undefined ? { jwksUri } : {}),
    ...(audience !== undefined ? { audience } : {}),
  };
}

function readApnsFromEnv(env: NodeJS.ProcessEnv): RelayConfiguration.ApnsCredentials | null {
  const teamId = optionalEnv(env["APNS_TEAM_ID"]);
  const keyId = optionalEnv(env["APNS_KEY_ID"]);
  const privateKey = optionalEnv(env["APNS_PRIVATE_KEY"]);
  const bundleId = optionalEnv(env["APNS_BUNDLE_ID"]);
  if (!teamId || !keyId || !privateKey || !bundleId) {
    return null;
  }
  const environment =
    optionalEnv(env["APNS_ENVIRONMENT"]) === "production" ? "production" : "sandbox";
  return {
    teamId,
    keyId,
    privateKey: Redacted.make(privateKey),
    bundleId,
    environment,
  };
}

async function main(): Promise<void> {
  const env = process.env;
  const databaseUrl = optionalEnv(env["DATABASE_URL"]);
  if (!databaseUrl) {
    await Effect.runPromise(Effect.logError("DATABASE_URL is required to start cove-cp."));
    process.exitCode = 1;
    return;
  }

  const migrateOnly = process.argv.slice(2).includes("--migrate-only");
  if (migrateOnly || optionalEnv(env["COVE_CP_AUTO_MIGRATE"]) !== "false") {
    const migrateEffect = Effect.gen(function* () {
      const path = yield* Path.Path;
      const migrationsDir = yield* path.fromFileUrl(
        new URL("../migrations/postgres", import.meta.url),
      );
      const result = yield* RelayDb.applyPostgresMigrations(migrationsDir);
      if (result.applied.length > 0) {
        yield* Effect.logInfo("Applied PostgreSQL migrations", { applied: result.applied });
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(RelayDb.layerPostgres(Redacted.make(databaseUrl)), NodeServices.layer),
      ),
    );
    await Effect.runPromise(migrateEffect);
    if (migrateOnly) return;
  }

  const host = optionalEnv(env["HOST"]) ?? "0.0.0.0";
  const port = parsePort(env["PORT"], 8787);
  const publicUrl = optionalEnv(env["COVE_CP_PUBLIC_URL"]);
  const dataDir = optionalEnv(env["COVE_CP_DATA_DIR"]);
  const oidc = readOidcFromEnv(env);
  if (oidc === null) {
    await Effect.runPromise(
      Effect.logWarning(
        "COVE_CP_OIDC_ISSUER / COVE_CP_OIDC_CLIENT_ID not set; user OIDC authentication is disabled.",
      ),
    );
  }

  const libp2pEnabled = optionalEnv(env["COVE_CP_LIBP2P_ENABLED"]) !== "false";
  const listenMultiaddrs = parseCommaList(env["COVE_CP_LIBP2P_LISTEN"], [
    "/ip4/0.0.0.0/tcp/4001",
    "/ip4/0.0.0.0/tcp/4002/ws",
  ]);
  const announceMultiaddrs = parseCommaList(env["COVE_CP_LIBP2P_ANNOUNCE"], []);
  const libp2pKeyPath = optionalEnv(env["COVE_CP_LIBP2P_KEY_PATH"]);
  const relayDurationMs = optionalEnv(env["COVE_CP_LIBP2P_RELAY_DURATION_MS"]);
  const relayBytes = optionalEnv(env["COVE_CP_LIBP2P_RELAY_BYTES"]);
  const tunnelSecret = optionalEnv(env["COVE_CP_TUNNEL_SECRET"]);

  const cloudMintPrivateKey = optionalEnv(env["COVE_CP_SIGNING_PRIVATE_KEY"]);
  const cloudMintPublicKey = optionalEnv(env["COVE_CP_SIGNING_PUBLIC_KEY"]);
  const apnsDeliveryJobSigningSecret = optionalEnv(env["COVE_CP_APNS_JOB_SECRET"]);
  const managedEndpointBaseDomain = optionalEnv(env["COVE_CP_TUNNEL_BASE_DOMAIN"]);
  const managedEndpointNamespace = optionalEnv(env["COVE_CP_TUNNEL_NAMESPACE"]);
  const defaultMaxManagedTunnels = parsePositiveInt(env["COVE_CP_MAX_MANAGED_TUNNELS"]);
  const fcmServiceAccount = optionalEnv(env["FCM_SERVICE_ACCOUNT_JSON"]);

  const handle = await startControlPlaneServer({
    host,
    port,
    databaseUrl,
    oidc,
    apns: readApnsFromEnv(env),
    ...(publicUrl !== undefined ? { publicUrl } : {}),
    ...(dataDir !== undefined ? { dataDir } : {}),
    ...(cloudMintPrivateKey !== undefined && cloudMintPublicKey !== undefined
      ? { cloudMintPrivateKey, cloudMintPublicKey }
      : {}),
    ...(apnsDeliveryJobSigningSecret !== undefined ? { apnsDeliveryJobSigningSecret } : {}),
    ...(fcmServiceAccount !== undefined ? { fcmServiceAccount } : {}),
    ...(managedEndpointBaseDomain !== undefined ? { managedEndpointBaseDomain } : {}),
    ...(managedEndpointNamespace !== undefined ? { managedEndpointNamespace } : {}),
    ...(defaultMaxManagedTunnels !== undefined ? { defaultMaxManagedTunnels } : {}),
    libp2p: {
      enabled: libp2pEnabled,
      ...(optionalEnv(env["COVE_CP_LIBP2P_REPLICAS"])
        ? { replicaMultiaddrs: parseCommaList(env["COVE_CP_LIBP2P_REPLICAS"], []) }
        : {}),
      listenMultiaddrs,
      announceMultiaddrs,
      connectionLimits: {
        ...(relayDurationMs !== undefined ? { durationMs: Number(relayDurationMs) } : {}),
        ...(relayBytes !== undefined ? { bytes: Number(relayBytes) } : {}),
      },
      ...(libp2pKeyPath !== undefined ? { keyPath: libp2pKeyPath } : {}),
      ...(tunnelSecret !== undefined ? { tunnelSecret } : {}),
    },
  });

  await Effect.runPromise(
    Effect.logInfo("cove-cp listening", {
      baseUrl: handle.baseUrl,
      relayIssuer: handle.relayIssuer,
      libp2pPeerId: handle.libp2pPeerId,
      libp2pMultiaddrs: handle.getLibp2pMultiaddrs(),
    }),
  );

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    void Effect.runPromise(Effect.logInfo("Shutting down cove-cp", { signal }))
      .catch(() => {})
      .then(() => handle.stop())
      .then(() => {
        process.exit(0);
      })
      .catch(() => {
        process.exit(1);
      });
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

await main().catch(async (error) => {
  await Effect.runPromise(Effect.logError("Failed to start cove-cp", { error })).catch(() => {});
  process.exit(1);
});
