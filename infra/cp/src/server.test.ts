// @effect-diagnostics-next-line nodeBuiltinImport:off -- RSA/Ed25519 key generation and RS256 signing for mock OIDC IdP.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Local HTTP test fixtures and client helpers without global fetch.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "@effect/vitest";
import {
  createEnvironmentLibp2pTunnel,
  createClientLibp2pProxy,
  environmentPeerIdFromKey,
  loadOrCreateLibp2pPrivateKey,
} from "@covecode/libp2p-tunnel";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { WebSocket, WebSocketServer } from "ws";

import * as RelayDb from "./db.ts";
import { makeReplicaDirectory } from "./environments/ReplicaDirectory.ts";
import * as PushJobs from "./agentActivity/PushJobs.ts";
import * as HookInbox from "./hooks/HookInbox.ts";
import {
  DEFAULT_MANAGED_ENDPOINT_NAMESPACE,
  managedEndpointPathKey,
  managedEndpointTunnelName,
} from "./deploymentConfig.ts";
import { deriveTunnelConnectorToken } from "./environments/Libp2pTunnelRegistry.ts";
import { relayEnvironmentLinks, relayManagedEndpointAllocations } from "./persistence/schema.ts";
import { startControlPlaneServer } from "./server.ts";

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
    if (req.method === "POST" && req.url === "/api/hooks/demo/tok%2Fen") {
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

describe("cove-cp", () => {
  it.live("expires dead replicas and fences callbacks from a previous boot of the same peer", () =>
    Effect.gen(function* () {
      const pg = yield* makePgliteRelayDb();
      yield* Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        const old = makeReplicaDirectory(db, "00000000-0000-4000-8000-000000000001");
        const replacement = makeReplicaDirectory(db, "00000000-0000-4000-8000-000000000002");
        const registration = {
          endpointKey: "endpoint",
          endpointId: "tunnel",
          peerId: "environment",
          directMultiaddrs: [],
          connectedAt: 1,
        };
        yield* old.start("relay", ["first"]);
        yield* old.record("endpoint", registration);
        expect(yield* replacement.routes(["endpoint"])).toHaveLength(1);
        yield* db.$client.unsafe("UPDATE cove_relay_replicas SET expires_at=now()");
        expect(yield* replacement.routes(["endpoint"])).toEqual([]);
        yield* replacement.start("relay", ["second"]);
        yield* replacement.record("endpoint", registration);
        expect(Exit.isFailure(yield* Effect.exit(old.heartbeat()))).toBe(true);
        yield* old.stop;
        yield* old.record("endpoint", null);
        expect(yield* replacement.routes(["endpoint"])).toEqual([
          { registration, addresses: ["second"] },
        ]);
      }).pipe(Effect.provide(pg.layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live(
    "reclaims abandoned push jobs in device order and retries stored webhooks through the consuming replica",
    () =>
      Effect.gen(function* () {
        const pg = yield* makePgliteRelayDb();
        yield* Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          yield* PushJobs.enqueue("fcm", "device", { sequence: 1 });
          yield* PushJobs.enqueue("fcm", "device", { sequence: 2 });
          const claimed = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const staleWorker = yield* PushJobs.consumeOne("fcm", () =>
            Deferred.succeed(claimed, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(claimed);
          const received: unknown[] = [];
          const deliver = (payload: unknown) =>
            Effect.sync(() => {
              received.push(payload);
            });
          expect(yield* PushJobs.consumeOne("fcm", deliver)).toBe(false);
          yield* db.$client.unsafe("UPDATE cove_push_jobs SET available_at=now() WHERE attempts=1");
          expect(yield* PushJobs.consumeOne("fcm", deliver)).toBe(true);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(staleWorker);
          expect(yield* PushJobs.consumeOne("fcm", deliver)).toBe(true);
          expect(received).toEqual([{ sequence: 1 }, { sequence: 2 }]);

          const inbox = yield* HookInbox.HookInbox;
          const endpointKey = "0123456789abcdef";
          const body = new Uint8Array([0, 128, 255]);
          const input = {
            endpointKey,
            baseUrl: "http://old-replica.test",
            hook: {
              id: "delivery-1",
              hookKey: "demo",
              rawHookId: "demo",
              rawToken: "token",
              method: "POST",
              receivedAt: "2026-11-26T00:00:00Z",
              query: "",
              headers: {},
              body,
            },
          };
          expect(yield* inbox.hold(input)).toBe(true);
          expect(yield* inbox.hold(input)).toBe(false);
          const forwarded: string[] = [];
          function drain(status: number) {
            return HookInbox.deliverOne((key) =>
              Effect.succeed(`http://new-replica.test/t/${key}/`),
            ).pipe(
              Effect.provideService(
                HttpClient.HttpClient,
                HttpClient.make((request) =>
                  Effect.sync(() => {
                    forwarded.push(request.url);
                    expect(request.headers["x-t3-relay-delivery-id"]).toBe(input.hook.id);
                    expect(request.body).toMatchObject({ body });
                    return HttpClientResponse.fromWeb(request, new Response(null, { status }));
                  }),
                ),
              ),
            );
          }
          expect(yield* inbox.wake(input)).toBe(true);
          expect(yield* drain(502)).toBe(true);
          expect(yield* inbox.wake(input)).toBe(true);
          expect(yield* drain(204)).toBe(true);
          expect(yield* inbox.wake(input)).toBe(false);
          expect(forwarded).toEqual(
            Array(2).fill(`http://new-replica.test/t/${endpointKey}/api/hooks/demo/token`),
          );
        }).pipe(Effect.provide(HookInbox.layerPostgres.pipe(Layer.provideMerge(pg.layer))));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live(
    "shares discovery and webhook routing across authenticated replicas and serves encrypted connections after one stops",
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
        const mintKeys = NodeCrypto.generateKeyPairSync("ed25519", {
          privateKeyEncoding: { format: "pem", type: "pkcs8" },
          publicKeyEncoding: { format: "pem", type: "spki" },
        });
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const prepare = Effect.fn("test.prepare_replica")(function* (name: string) {
          const keyPath = `${directory}/${name}.key`;
          yield* Effect.promise(() => loadOrCreateLibp2pPrivateKey(keyPath));
          const peer = environmentPeerIdFromKey(yield* fs.readFile(keyPath));
          const listener = yield* Effect.acquireRelease(
            Effect.sync(() => NodeHttp.createServer()),
            (server) =>
              Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
          );
          const port = yield* Effect.promise(() => listenNodeHttpServer(listener));
          const address = `/ip4/127.0.0.1/tcp/${port}/ws`;
          return { listener, keyPath, address, qualified: `${address}/p2p/${peer}` };
        });
        const first = yield* prepare("a");
        const second = yield* prepare("b");
        const replicaMultiaddrs = [first.qualified, second.qualified];
        const start = (replica: typeof first) =>
          Effect.acquireRelease(
            Effect.promise(async () => {
              await new Promise<void>((resolve) => replica.listener.close(() => resolve()));
              return startControlPlaneServer({
                host: "127.0.0.1",
                port: 0,
                relayDbLayer: pgDb.layer,
                publicUrl: "http://cp.example.test",
                cloudMintPrivateKey: mintKeys.privateKey,
                cloudMintPublicKey: mintKeys.publicKey,
                oidc: {
                  issuer: oidc.issuer,
                  clientId: oidcClientId,
                  audience: oidcClientId,
                  scopes: ["openid", "profile", "email"],
                },
                libp2p: {
                  enabled: true,
                  listenMultiaddrs: [replica.address],
                  keyPath: replica.keyPath,
                  replicaMultiaddrs,
                  tunnelSecret,
                },
              });
            }),
            (handle) => Effect.promise(() => handle.stop()).pipe(Effect.ignore),
          );
        const relay = yield* start(first);
        const other = yield* start(second);
        expect(relay.libp2pPeerId).toBeTruthy();
        expect(relay.getLibp2pMultiaddrs().length).toBeGreaterThan(0);

        const root = yield* Effect.promise(() => httpRequestJson({ url: relay.baseUrl }));
        expect(root.body).toMatchObject({ service: "cove-cp" });

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
            peerId: null,
            relayMultiaddrs: replicaMultiaddrs,
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
              endpointId: tunnelId,
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
            url: `${other.baseUrl}/v1/environments`,
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

        const forwarded = yield* Effect.promise(() =>
          httpRequestJson({
            url: `${other.baseUrl}/v1/hooks/${endpointKey}/demo/tok%2Fen`,
            method: "POST",
            body: { event: "from-provider" },
          }),
        );
        expect(forwarded.status).toBe(200);
        expect(forwarded.body).toMatchObject({ body: { event: "from-provider" } });
        // The environment is registered only on A. B must route the webhook through A.
        expect(envListConnected.body).toMatchObject({
          environments: [
            {
              endpoint: {
                libp2pRelayMultiaddrs: [first.qualified],
              },
            },
          ],
        });
        yield* Effect.promise(() => tunnel.stop());
        const reservedBoth = yield* Deferred.make<void>();
        let connected = 0;
        const redundant = yield* Effect.acquireRelease(
          Effect.promise(() =>
            createEnvironmentLibp2pTunnel({
              relayMultiaddrs: replicaMultiaddrs,
              endpointId: tunnelId,
              endpointKey,
              connectorToken,
              localHost: "127.0.0.1",
              localPort: dummyEnv.port,
              enableP2p: false,
              onStatusChange: ({ state }) => {
                if (state === "connected" && ++connected === 2)
                  Deferred.doneUnsafe(reservedBoth, Effect.void);
              },
            }),
          ),
          (t) => Effect.promise(() => t.stop()),
        );
        yield* Deferred.await(reservedBoth);
        yield* Effect.promise(() => relay.stop());
        const surviving = yield* Effect.promise(() =>
          httpRequestJson({
            url: `${other.baseUrl}/v1/environments`,
            headers: { authorization: `Bearer ${validJwt}` },
          }),
        );
        expect(surviving.body).toMatchObject({
          environments: [
            {
              endpoint: {
                libp2pPeerId: redundant.peerId,
                libp2pRelayMultiaddrs: [second.qualified],
              },
            },
          ],
        });
        const proxy = yield* Effect.acquireRelease(
          Effect.promise(() =>
            createClientLibp2pProxy({
              relayMultiaddrs: [second.qualified],
              targetPeerId: redundant.peerId,
              mode: "relay",
            }),
          ),
          (value) => Effect.promise(() => value.stop()),
        );
        const throughCircuit = yield* Effect.promise(() =>
          httpRequestJson({ url: proxy.httpBaseUrl + "/hello" }),
        );
        expect(throughCircuit.body).toMatchObject({ from: "dummy-env" });
        const afterFailure = yield* Effect.promise(() =>
          httpRequestJson({
            url: `${other.baseUrl}/v1/hooks/${endpointKey}/demo/tok%2Fen`,
            method: "POST",
            body: { event: "after-stop" },
          }),
        );
        expect(afterFailure.body).toMatchObject({ body: { event: "after-stop" } });
        const proxiedGet = yield* Effect.promise(() =>
          httpRequestJson({
            url: `${other.baseUrl}/t/${endpointKey}/hello`,
          }),
        );
        expect(proxiedGet.status).toBe(404);
        const upgradeStatus = yield* Effect.promise(
          () =>
            new Promise<number>((resolve, reject) => {
              const ws = new WebSocket(`ws://127.0.0.1:${other.port}/t/${endpointKey}/ws`);
              ws.once("unexpected-response", (_request, response) => {
                response.resume();
                resolve(response.statusCode ?? 0);
                ws.terminate();
              });
              ws.once("open", () => {
                ws.close();
                reject(new Error("Plaintext tunnel upgrade accepted"));
              });
              ws.once("error", reject);
            }),
        );
        expect(upgradeStatus).toBe(404);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
