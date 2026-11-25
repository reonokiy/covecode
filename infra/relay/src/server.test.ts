// @effect-diagnostics-next-line nodeBuiltinImport:off -- RSA/Ed25519 key generation and RS256 signing for mock OIDC IdP.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Local HTTP test fixtures and client helpers without global fetch.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "@effect/vitest";
import { createEnvironmentLibp2pTunnel } from "@t3tools/libp2p-tunnel";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { WebSocket, WebSocketServer } from "ws";

import * as RelayDb from "./db.ts";
import {
  DEFAULT_MANAGED_ENDPOINT_NAMESPACE,
  managedEndpointPathKey,
  managedEndpointTunnelName,
} from "./deploymentConfig.ts";
import { deriveTunnelConnectorToken } from "./environments/Libp2pTunnelRegistry.ts";
import { relayEnvironmentLinks, relayManagedEndpointAllocations } from "./persistence/schema.ts";
import { startSelfHostedRelayServer } from "./server.ts";

interface PgShimState {
  readonly layer: Layer.Layer<RelayDb.RelayDb | RelayDb.RelayTransactions>;
  readonly insertLinkedEnvironment: (input: {
    readonly userId: string;
    readonly environmentId: string;
    readonly endpointKey: string;
    readonly tunnelId: string;
    readonly environmentPublicKey: string;
    readonly httpBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly nowIso: string;
  }) => Effect.Effect<void>;
}

const makePgliteRelayDb = () =>
  Effect.gen(function* () {
    const pg = yield* Effect.acquireRelease(
      Effect.promise(() => PGlite.create()),
      (client) => Effect.promise(() => client.close()).pipe(Effect.ignore),
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const migrationsDir = yield* path.fromFileUrl(
      new URL("../migrations/postgres/", import.meta.url),
    );
    const folders = (yield* fs.readDirectory(migrationsDir)).toSorted();
    for (const folder of folders) {
      const sqlPath = path.join(migrationsDir, folder, "migration.sql");
      if (!(yield* fs.exists(sqlPath))) continue;
      const migrationSql = yield* fs.readFileString(sqlPath);
      yield* Effect.promise(() => pg.exec(migrationSql));
    }

    const txLock = Semaphore.makeUnsafe(1);
    let txDepth = 0;

    const unsafe = (sql: string, params: ReadonlyArray<unknown> = []) => {
      const raw = Effect.promise(() =>
        pg.query(sql, [...params]).then((res) => res.rows as ReadonlyArray<unknown>),
      );
      const values = Effect.promise(() =>
        pg
          .query(sql, [...params], { rowMode: "array" })
          .then((res) => res.rows as ReadonlyArray<unknown>),
      );
      return Object.assign(raw, {
        values,
        withoutTransform: raw,
        raw,
      });
    };

    const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      txLock.withPermits(1)(
        Effect.gen(function* () {
          const depth = txDepth;
          txDepth += 1;
          const beginSql = depth === 0 ? "BEGIN" : `SAVEPOINT sp_${depth}`;
          const commitSql = depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT sp_${depth}`;
          const rollbackSql = depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT sp_${depth}`;
          return yield* Effect.acquireUseRelease(
            Effect.promise(() => pg.exec(beginSql)),
            () => effect,
            (_res, exit) =>
              Effect.promise(() => pg.exec(Exit.isSuccess(exit) ? commitSql : rollbackSql)).pipe(
                Effect.ignore,
              ),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                txDepth = Math.max(0, txDepth - 1);
              }),
            ),
          );
        }),
      );

    const shim = {
      unsafe,
      withTransaction,
    } as unknown as PgClient.PgClient;

    const db = yield* PgDrizzle.makeWithDefaults().pipe(
      Effect.provideService(PgClient.PgClient, shim),
    );
    const relayDbService = RelayDb.RelayDb.of(db as unknown as RelayDb.RelayDb["Service"]);
    const dbLayer = Layer.succeed(RelayDb.RelayDb, relayDbService);
    const txLayer = RelayDb.RelayTransactions.layer.pipe(Layer.provide(dbLayer));
    const combinedLayer = Layer.mergeAll(dbLayer, txLayer);

    const insertLinkedEnvironment: PgShimState["insertLinkedEnvironment"] = (input) =>
      Effect.gen(function* () {
        yield* db.insert(relayManagedEndpointAllocations).values({
          userId: input.userId,
          environmentId: input.environmentId,
          hostname: managedEndpointPathKey(input.endpointKey),
          tunnelId: input.tunnelId,
          tunnelName: managedEndpointTunnelName(
            DEFAULT_MANAGED_ENDPOINT_NAMESPACE,
            input.endpointKey,
          ),
          dnsRecordId: "libp2p",
          readyAt: input.nowIso,
          recoveryEnabledAt: null,
          recoveryEnvironmentPublicKey: null,
          tunnelReleasedAt: null,
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
          generation: 1,
          createdAt: input.nowIso,
          updatedAt: input.nowIso,
        });
        yield* db.insert(relayEnvironmentLinks).values({
          userId: input.userId,
          environmentId: input.environmentId,
          environmentLabel: "Self-Hosted Test Environment",
          environmentPublicKey: input.environmentPublicKey,
          endpointHttpBaseUrl: input.httpBaseUrl,
          endpointWsBaseUrl: input.wsBaseUrl,
          endpointProviderKind: "libp2p_tunnel",
          notificationsEnabled: true,
          liveActivitiesEnabled: false,
          managedTunnelsEnabled: true,
          holdWebhooksWhileOffline: false,
          revokedAt: null,
          createdAt: input.nowIso,
          updatedAt: input.nowIso,
        });
      }).pipe(Effect.orDie);

    return { layer: combinedLayer, insertLinkedEnvironment } satisfies PgShimState;
  });

async function listenNodeHttpServer(server: NodeHttp.Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address() as NodeNet.AddressInfo | null;
      if (!addr) {
        reject(new Error("Server address unavailable"));
        return;
      }
      resolve(addr.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

async function startMockOidcIdp() {
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" });
  const jwks = {
    keys: [
      {
        ...jwk,
        kid: "oidc-test-kid",
        use: "sig",
        alg: "RS256",
      },
    ],
  };

  let issuer = "";
  const server = NodeHttp.createServer((req, res) => {
    if (req.url === "/.well-known/openid-configuration") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          issuer,
          jwks_uri: `${issuer}/jwks.json`,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }),
      );
      return;
    }
    if (req.url === "/jwks.json") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(jwks));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const port = await listenNodeHttpServer(server);
  issuer = `http://127.0.0.1:${port}`;

  const signIdToken = (input: {
    readonly sub: string;
    readonly email: string;
    readonly aud: string;
    readonly iatSeconds: number;
  }): string => {
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: "oidc-test-kid" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: issuer,
        sub: input.sub,
        aud: input.aud,
        email: input.email,
        iat: input.iatSeconds,
        exp: input.iatSeconds + 300,
      }),
    ).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const signature = NodeCrypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString(
      "base64url",
    );
    return `${signingInput}.${signature}`;
  };

  return {
    issuer,
    signIdToken,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function startDummyEnvironmentServer() {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      const msg = isBinary ? Buffer.from(data as Buffer).toString("utf8") : String(data);
      socket.send(`echo:${msg}`);
    });
  });

  const server = NodeHttp.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/hello") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, from: "dummy-env", path: req.url }));
      return;
    }
    if (req.method === "POST" && req.url === "/echo") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  const port = await listenNodeHttpServer(server);
  return {
    port,
    close: async () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

async function httpRequestJson(input: {
  readonly method?: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
  return await new Promise((resolve, reject) => {
    const req = NodeHttp.request(
      input.url,
      {
        method: input.method ?? "GET",
        headers: {
          ...(payload !== undefined
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              }
            : {}),
          ...input.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = text;
          if (text.length > 0) {
            try {
              parsed = JSON.parse(text) as unknown;
            } catch {
              parsed = text;
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

describe("self-hosted relay server", () => {
  it.live(
    "serves OIDC control-plane metadata, authenticates OIDC JWTs, and proxies HTTP + WS over libp2p",
    () =>
      Effect.gen(function* () {
        const oidc = yield* Effect.acquireRelease(
          Effect.promise(() => startMockOidcIdp()),
          (idp) => Effect.promise(() => idp.close()).pipe(Effect.ignore),
        );
        const dummyEnv = yield* Effect.acquireRelease(
          Effect.promise(() => startDummyEnvironmentServer()),
          (env) => Effect.promise(() => env.close()).pipe(Effect.ignore),
        );
        const pgDb = yield* makePgliteRelayDb();

        const tunnelSecret = "integration-tunnel-secret";
        const oidcClientId = "cove-integration-client";
        const relay = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startSelfHostedRelayServer({
              host: "127.0.0.1",
              port: 0,
              relayDbLayer: pgDb.layer,
              oidc: {
                issuer: oidc.issuer,
                clientId: oidcClientId,
                audience: oidcClientId,
                scopes: ["openid", "profile", "email"],
              },
              libp2p: {
                enabled: true,
                listenMultiaddrs: ["/ip4/127.0.0.1/tcp/0/ws", "/ip4/127.0.0.1/tcp/0"],
                tunnelSecret,
              },
            }),
          ),
          (handle) => Effect.promise(() => handle.stop()).pipe(Effect.ignore),
        );

        expect(relay.libp2pPeerId).toBeTruthy();
        expect(relay.getLibp2pMultiaddrs().length).toBeGreaterThan(0);

        const metadataRes = yield* Effect.promise(() =>
          httpRequestJson({ url: `${relay.baseUrl}/.well-known/cove-control-plane` }),
        );
        expect(metadataRes.status).toBe(200);
        expect(metadataRes.body).toEqual({
          controlPlaneUrl: relay.relayIssuer,
          oidc: {
            issuer: oidc.issuer,
            clientId: oidcClientId,
            audience: oidcClientId,
            scopes: ["openid", "profile", "email"],
          },
          libp2p: {
            enabled: true,
            peerId: relay.libp2pPeerId,
            relayMultiaddrs: relay.getLibp2pMultiaddrs(),
          },
        });

        const unauthenticated = yield* Effect.promise(() =>
          httpRequestJson({ url: `${relay.baseUrl}/v1/environments` }),
        );
        expect(unauthenticated.status).toBe(401);

        const invalidBearer = yield* Effect.promise(() =>
          httpRequestJson({
            url: `${relay.baseUrl}/v1/environments`,
            headers: { authorization: "Bearer invalid.jwt.token" },
          }),
        );
        expect(invalidBearer.status).toBe(401);

        const now = yield* DateTime.now;
        const validJwt = oidc.signIdToken({
          sub: "oidc-subject-1",
          email: "dev@example.test",
          aud: oidcClientId,
          iatSeconds: Math.floor(now.epochMilliseconds / 1_000),
        });

        const authenticatedEmpty = yield* Effect.promise(() =>
          httpRequestJson({
            url: `${relay.baseUrl}/v1/environments`,
            headers: { authorization: `Bearer ${validJwt}` },
          }),
        );
        expect(authenticatedEmpty.status).toBe(200);
        expect(authenticatedEmpty.body).toEqual({ environments: [] });

        const endpointKey = "0123456789abcdef";
        const environmentId = "env-selfhosted-1";
        const tunnelId = "libp2p-tunnel-1";
        yield* pgDb.insertLinkedEnvironment({
          userId: "oidc-subject-1",
          environmentId,
          endpointKey,
          tunnelId,
          environmentPublicKey: "test-env-public-key",
          httpBaseUrl: `${relay.relayIssuer}/t/${endpointKey}/`,
          wsBaseUrl: `${relay.relayIssuer.replace("http://", "ws://")}/t/${endpointKey}/ws`,
          nowIso: DateTime.formatIso(now),
        });

        const connectorToken = deriveTunnelConnectorToken(tunnelSecret, {
          endpointKey,
          tunnelId,
          environmentId,
        });
        const tunnel = yield* Effect.acquireRelease(
          Effect.promise(() =>
            createEnvironmentLibp2pTunnel({
              relayMultiaddrs: relay.getLibp2pMultiaddrs(),
              endpointId: environmentId,
              endpointKey,
              connectorToken,
              localHost: "127.0.0.1",
              localPort: dummyEnv.port,
              enableP2p: false,
            }),
          ),
          (t) => Effect.promise(() => t.stop()).pipe(Effect.ignore),
        );

        const envListConnected = yield* Effect.promise(() =>
          httpRequestJson({
            url: `${relay.baseUrl}/v1/environments`,
            headers: { authorization: `Bearer ${validJwt}` },
          }),
        );
        expect(envListConnected.status).toBe(200);
        expect(envListConnected.body).toMatchObject({
          environments: [
            {
              environmentId,
              endpoint: {
                providerKind: "libp2p_tunnel",
                libp2pPeerId: tunnel.peerId,
                transportMode: "p2p",
              },
            },
          ],
        });

        const proxiedGet = yield* Effect.promise(() =>
          httpRequestJson({
            url: `${relay.baseUrl}/t/${endpointKey}/hello`,
          }),
        );
        expect(proxiedGet.status).toBe(200);
        expect(proxiedGet.body).toEqual({
          ok: true,
          from: "dummy-env",
          path: "/hello",
        });

        const proxiedPost = yield* Effect.promise(() =>
          httpRequestJson({
            method: "POST",
            url: `${relay.baseUrl}/t/${endpointKey}/echo`,
            body: { hello: "cove" },
          }),
        );
        expect(proxiedPost.status).toBe(200);
        expect(proxiedPost.body).toEqual({
          ok: true,
          body: { hello: "cove" },
        });

        const wsReply = yield* Effect.promise(
          () =>
            new Promise<string>((resolve, reject) => {
              const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/t/${endpointKey}/ws`);
              ws.once("error", reject);
              ws.once("open", () => {
                ws.send("ping");
              });
              ws.once("message", (data, isBinary) => {
                const text = isBinary ? Buffer.from(data as Buffer).toString("utf8") : String(data);
                ws.close();
                resolve(text);
              });
            }),
        );
        expect(wsReply).toBe("echo:ping");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
