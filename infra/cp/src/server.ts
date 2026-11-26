// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect Crypto lacks Ed25519 key pair generation.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Raw HTTP and WebSocket upgrade hijacking for libp2p tunnels.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Socket stream passed directly to libp2p proxyUpgrade.
import type * as NodeStream from "node:stream";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RelayApi } from "@t3tools/contracts/relay";
import { normalizeRelayIssuer } from "@t3tools/shared/relayJwt";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PushJobs from "./agentActivity/PushJobs.ts";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Etag from "effect/http/Etag";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as RelayConfiguration from "./Config.ts";
import * as WebCrypto from "./WebCrypto.ts";
import * as AgentActivityPublisher from "./agentActivity/AgentActivityPublisher.ts";
import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as ApnsClient from "./agentActivity/ApnsClient.ts";
import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsProviderTokens from "./agentActivity/ApnsProviderTokens.ts";
import * as DeliveryAttempts from "./agentActivity/DeliveryAttempts.ts";
import * as Devices from "./agentActivity/Devices.ts";
import * as FcmAssertionSigner from "./agentActivity/FcmAssertionSigner.ts";
import * as FcmClient from "./agentActivity/FcmClient.ts";
import * as FcmDeliveries from "./agentActivity/FcmDeliveries.ts";
import * as FcmDeliveryQueueSender from "./agentActivity/FcmDeliveryQueueSender.ts";
import * as LiveActivities from "./agentActivity/LiveActivities.ts";
import * as MobileRegistrations from "./agentActivity/MobileRegistrations.ts";

import * as CloudMintSigner from "./auth/CloudMintSigner.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as OidcAuth from "./auth/OidcAuth.ts";
import * as RelayTokens from "./auth/RelayTokens.ts";
import * as RelayDb from "./db.ts";
import {
  extractEndpointKeyFromPath,
  extractEndpointKeyFromSubdomainHost,
} from "./deploymentConfig.ts";
import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import * as EnvironmentCredentials from "./environments/EnvironmentCredentials.ts";
import * as EnvironmentLinker from "./environments/EnvironmentLinker.ts";
import * as EnvironmentLinks from "./environments/EnvironmentLinks.ts";
import * as EnvironmentPublishSignatures from "./environments/EnvironmentPublishSignatures.ts";
import * as Libp2pTunnelRegistry from "./environments/Libp2pTunnelRegistry.ts";
import * as ManagedEndpointAllocations from "./environments/ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "./environments/ManagedTunnelLimits.ts";
import * as HeldHooks from "./hooks/HeldHooks.ts";
import * as HookForwarder from "./hooks/HookForwarder.ts";
import * as HookInbox from "./hooks/HookInbox.ts";
import * as RelayHttpApi from "./http/Api.ts";
import * as MobileTelemetry from "./mobileTelemetry/MobileTelemetry.ts";
import * as T3ChatAccounts from "./t3chat/T3ChatAccounts.ts";

const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;
const CLEANUP_INTERVAL = Duration.minutes(15);
const TERMINAL_ACTIVITY_RETENTION_DAYS = 7;

export interface ControlPlaneServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly publicUrl?: string;
  readonly databaseUrl?: string;
  readonly relayDbLayer?: Layer.Layer<RelayDb.RelayDb | RelayDb.RelayTransactions>;
  readonly oidc: RelayConfiguration.OidcProviderConfiguration | null;
  readonly oidcAuthLayer?: Layer.Layer<
    OidcAuth.OidcAuth,
    never,
    RelayConfiguration.RelayConfiguration
  >;
  readonly dataDir?: string;
  readonly cloudMintPrivateKey?: string;
  readonly cloudMintPublicKey?: string;
  readonly apns?: RelayConfiguration.ApnsCredentials | null;
  readonly fcmServiceAccount?: string;
  readonly apnsDeliveryJobSigningSecret?: string;
  readonly managedEndpointBaseDomain?: string;
  readonly managedEndpointNamespace?: string;
  readonly defaultMaxManagedTunnels?: number;
  readonly t3Chat?: RelayConfiguration.T3ChatSettings;
  readonly libp2p?: {
    readonly enabled?: boolean;
    readonly listenMultiaddrs?: ReadonlyArray<string>;
    readonly replicaMultiaddrs?: ReadonlyArray<string>;
    readonly announceMultiaddrs?: ReadonlyArray<string>;
    readonly keyPath?: string;
    readonly tunnelSecret?: string;
    readonly connectionLimits?: NonNullable<
      RelayConfiguration.Libp2pGatewayConfiguration["connectionLimits"]
    >;
  };
}

export interface ControlPlaneServerHandle {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly relayIssuer: string;
  readonly libp2pPeerId: string | null;
  readonly getLibp2pMultiaddrs: () => ReadonlyArray<string>;
  readonly stop: () => Promise<void>;
}

const makeHookRateLimiter = (db: RelayDb.RelayDb["Service"]) => {
  const check = (prefix: string, limit: number, periodSeconds: number) =>
    Effect.fn("cp.hook.check_limit")(function* (key: string) {
      const rows = yield* db.$client
        .unsafe(
          `INSERT INTO cove_hook_windows AS w VALUES ($1, ARRAY[statement_timestamp()], statement_timestamp()+$3 * interval '1 second')
         ON CONFLICT (bucket) DO UPDATE SET hits=ARRAY(
           SELECT t FROM unnest(w.hits) t WHERE t > statement_timestamp()-$3 * interval '1 second'
         ) || excluded.hits, expires_at=excluded.expires_at
         WHERE cardinality(w.hits)<$2 OR w.hits[1] <= statement_timestamp()-$3 * interval '1 second'
         RETURNING bucket`,
          [prefix + ":" + key, limit, periodSeconds],
        )
        .pipe(Effect.orDie);
      return rows.length > 0;
    });
  return HookForwarder.HookRateLimiter.of({
    allowHook: check(
      "hook",
      HookForwarder.RELAY_HOOK_RATE_LIMIT.limit,
      HookForwarder.RELAY_HOOK_RATE_LIMIT.periodSeconds,
    ),
    allowEndpoint: check(
      "endpoint",
      HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT.limit,
      HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT.periodSeconds,
    ),
  });
};

const loadOrGenerateSecrets = Effect.fn("relay.server.load_secrets")(function* (
  options: ControlPlaneServerOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (options.dataDir) {
    yield* fs.makeDirectory(options.dataDir, { recursive: true, mode: 0o700 });
  }

  const readOrGenerateSecretFile = Effect.fnUntraced(function* (
    explicitValue: string | undefined,
    fileName: string,
  ) {
    if (explicitValue) return explicitValue;
    if (!options.dataDir) {
      return NodeCrypto.randomBytes(32).toString("base64url");
    }
    const targetPath = path.join(options.dataDir, fileName);
    if (yield* fs.exists(targetPath)) {
      const existing = (yield* fs.readFileString(targetPath)).trim();
      if (existing.length > 0) return existing;
    }
    const generated = NodeCrypto.randomBytes(32).toString("base64url");
    yield* fs.writeFileString(targetPath, `${generated}\n`, { mode: 0o600 });
    return generated;
  });

  const loadOrGenerateMintKeyPair = Effect.gen(function* () {
    if (options.cloudMintPrivateKey && options.cloudMintPublicKey) {
      return {
        privateKey: options.cloudMintPrivateKey,
        publicKey: options.cloudMintPublicKey,
      };
    }
    if (options.dataDir) {
      const privPath = path.join(options.dataDir, "cloud-mint-ed25519.pkcs8.pem");
      const pubPath = path.join(options.dataDir, "cloud-mint-ed25519.spki.pem");
      if ((yield* fs.exists(privPath)) && (yield* fs.exists(pubPath))) {
        const privateKey = yield* fs.readFileString(privPath);
        const publicKey = yield* fs.readFileString(pubPath);
        if (privateKey.trim().length > 0 && publicKey.trim().length > 0) {
          return { privateKey, publicKey };
        }
      }
      const pair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      yield* fs.writeFileString(privPath, pair.privateKey, { mode: 0o600 });
      yield* fs.writeFileString(pubPath, pair.publicKey, { mode: 0o644 });
      return pair;
    }
    return NodeCrypto.generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
  });

  const [mintKeys, tunnelSecret, apnsDeliveryJobSigningSecret] = yield* Effect.all([
    loadOrGenerateMintKeyPair,
    readOrGenerateSecretFile(options.libp2p?.tunnelSecret, "tunnel-secret.key"),
    readOrGenerateSecretFile(options.apnsDeliveryJobSigningSecret, "apns-job-secret.key"),
  ]);

  const libp2pKeyPath =
    options.libp2p?.keyPath ??
    (options.dataDir ? path.join(options.dataDir, "libp2p-peer.key") : undefined);

  return {
    cloudMintPrivateKey: mintKeys.privateKey,
    cloudMintPublicKey: mintKeys.publicKey,
    tunnelSecret,
    apnsDeliveryJobSigningSecret,
    libp2pKeyPath,
  };
});

async function listenHttpServer(
  server: NodeHttp.Server,
  host: string,
  port: number,
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("cove-cp HTTP server failed to resolve listening port"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function closeHttpServer(server: NodeHttp.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function readNodeRequestBody(req: NodeHttp.IncomingMessage): Promise<Uint8Array> {
  const chunks: Array<Buffer> = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > MAX_HTTP_BODY_BYTES) {
      throw new Error(`Request body exceeded ${MAX_HTTP_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

function resolveRequestScheme(req: NodeHttp.IncomingMessage): "http" | "https" {
  const forwarded = req.headers["x-forwarded-proto"];
  if (typeof forwarded === "string") {
    const first = forwarded.split(",", 1)[0]?.trim().toLowerCase();
    if (first === "https" || first === "http") return first;
  }
  return "http";
}

async function nodeToWebRequest(req: NodeHttp.IncomingMessage): Promise<Request> {
  const method = (req.method ?? "GET").toUpperCase();
  const host = req.headers.host ?? "127.0.0.1";
  const scheme = resolveRequestScheme(req);
  const url = `${scheme}://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  const body = await readNodeRequestBody(req);
  return new Request(url, {
    method,
    headers,
    ...(body.byteLength > 0 ? { body: Uint8Array.from(body) } : {}),
  });
}

async function writeWebResponseToNode(
  webResponse: Response,
  res: NodeHttp.ServerResponse,
): Promise<void> {
  if (res.writableEnded) return;
  res.statusCode = webResponse.status;
  const setCookies =
    typeof webResponse.headers.getSetCookie === "function"
      ? webResponse.headers.getSetCookie()
      : [];
  if (setCookies.length > 0) {
    res.setHeader("set-cookie", setCookies);
  }
  webResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    res.setHeader(key, value);
  });
  const body = new Uint8Array(await webResponse.arrayBuffer());
  res.end(body);
}

export async function startControlPlaneServer(
  options: ControlPlaneServerOptions,
): Promise<ControlPlaneServerHandle> {
  if (!options.relayDbLayer && !options.databaseUrl) {
    throw new Error("cove-cp requires either databaseUrl or relayDbLayer");
  }

  if (
    options.libp2p?.replicaMultiaddrs &&
    (!options.publicUrl ||
      !options.cloudMintPrivateKey ||
      !options.cloudMintPublicKey ||
      !options.libp2p.tunnelSecret ||
      (options.apns && !options.apnsDeliveryJobSigningSecret))
  ) {
    throw new Error(
      "Replicas require a common public URL, mint key pair, tunnel secret and, for APNs, shared job signing secret",
    );
  }
  const host = options.host ?? "0.0.0.0";
  const requestedPort = options.port ?? 8787;
  const httpServer = NodeHttp.createServer();
  const actualPort = await listenHttpServer(httpServer, host, requestedPort);

  const connectHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const relayIssuer = options.publicUrl
    ? normalizeRelayIssuer(options.publicUrl)
    : `http://${connectHost}:${actualPort}`;
  const internalGateway = NodeHttp.createServer();
  const scope = await Effect.runPromise(Scope.make());

  try {
    const internalPort = await listenHttpServer(internalGateway, "127.0.0.1", 0);
    const internalGatewayBaseUrl = `http://127.0.0.1:${internalPort}`;
    const bootEffect = Effect.gen(function* () {
      const memoMap = yield* Layer.makeMemoMap;
      const secrets = yield* loadOrGenerateSecrets(options);

      const libp2pEnabled = options.libp2p?.enabled ?? true;
      const config: RelayConfiguration.RelayConfiguration["Service"] = {
        relayIssuer,
        oidc: options.oidc,
        libp2p: {
          enabled: libp2pEnabled,
          ...(options.libp2p?.replicaMultiaddrs
            ? { replicaMultiaddrs: options.libp2p.replicaMultiaddrs }
            : {}),
          listenMultiaddrs: options.libp2p?.listenMultiaddrs ?? [
            "/ip4/0.0.0.0/tcp/4001",
            "/ip4/0.0.0.0/tcp/4002/ws",
          ],
          announceMultiaddrs: options.libp2p?.announceMultiaddrs ?? [],
          ...(secrets.libp2pKeyPath !== undefined ? { keyPath: secrets.libp2pKeyPath } : {}),
          tunnelSecret: Redacted.make(secrets.tunnelSecret),
          ...(options.libp2p?.connectionLimits !== undefined
            ? { connectionLimits: options.libp2p.connectionLimits }
            : {}),
          internalGatewayBaseUrl,
        },
        apns: options.apns ?? null,
        ...(options.fcmServiceAccount !== undefined
          ? { fcmServiceAccount: Redacted.make(options.fcmServiceAccount) }
          : {}),
        apnsDeliveryJobSigningSecret: Redacted.make(secrets.apnsDeliveryJobSigningSecret),
        cloudMintPrivateKey: Redacted.make(secrets.cloudMintPrivateKey),
        cloudMintPublicKey: secrets.cloudMintPublicKey,
        managedEndpointBaseDomain: options.managedEndpointBaseDomain,
        managedEndpointNamespace: options.managedEndpointNamespace,
        ...(options.defaultMaxManagedTunnels !== undefined
          ? { defaultMaxManagedTunnels: options.defaultMaxManagedTunnels }
          : {}),
        ...(options.t3Chat !== undefined ? { t3Chat: options.t3Chat } : {}),
      };

      const platformLayer = Layer.mergeAll(
        NodeServices.layer,
        NodeCryptoLayer.layer,
        NodeHttpPlatform.layer,
        FetchHttpClient.layer,
        Etag.layerWeak,
        Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle }),
      );

      const dbLayer =
        options.relayDbLayer ?? RelayDb.layerPostgres(Redacted.make(options.databaseUrl!));
      const configLayer = RelayConfiguration.layer(config);
      const baseLayer = Layer.mergeAll(platformLayer, configLayer, dbLayer);

      const oidcAuthLayer = (options.oidcAuthLayer ?? OidcAuth.layer).pipe(
        Layer.provideMerge(baseLayer),
      );
      const cloudMintSignerLayer = CloudMintSigner.layer.pipe(Layer.provideMerge(baseLayer));
      const dpopProofsLayer = DpopProofs.layer.pipe(Layer.provideMerge(baseLayer));
      const relayTokensLayer = RelayTokens.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(baseLayer, cloudMintSignerLayer)),
      );

      const linksLayer = EnvironmentLinks.layer.pipe(Layer.provideMerge(baseLayer));
      const credentialsLayer = EnvironmentCredentials.layer.pipe(Layer.provideMerge(baseLayer));
      const allocationsLayer = ManagedEndpointAllocations.layer.pipe(Layer.provideMerge(baseLayer));
      const t3ChatLayer = T3ChatAccounts.layer.pipe(Layer.provideMerge(baseLayer));
      const tunnelLimitsLayer = ManagedTunnelLimits.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(baseLayer, t3ChatLayer)),
      );
      const tunnelRegistryLayer = (
        libp2pEnabled ? Libp2pTunnelRegistry.layerLive : Libp2pTunnelRegistry.layerDisabled
      ).pipe(Layer.provideMerge(Layer.mergeAll(baseLayer, allocationsLayer, linksLayer)));
      const managedEndpointProviderLayer = ManagedEndpointProvider.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(baseLayer, allocationsLayer, tunnelLimitsLayer)),
      );
      const environmentLinkerLayer = EnvironmentLinker.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            baseLayer,
            cloudMintSignerLayer,
            dpopProofsLayer,
            relayTokensLayer,
            linksLayer,
            credentialsLayer,
            managedEndpointProviderLayer,
          ),
        ),
      );
      const environmentConnectorLayer = EnvironmentConnector.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            baseLayer,
            cloudMintSignerLayer,
            linksLayer,
            allocationsLayer,
            tunnelRegistryLayer,
          ),
        ),
      );
      const publishSignaturesLayer = EnvironmentPublishSignatures.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(baseLayer, dpopProofsLayer)),
      );

      const devicesLayer = Devices.layer.pipe(Layer.provideMerge(baseLayer));
      const liveActivitiesLayer = LiveActivities.layer.pipe(Layer.provideMerge(baseLayer));
      const agentActivityRowsLayer = AgentActivityRows.layer.pipe(Layer.provideMerge(baseLayer));
      const deliveryAttemptsLayer = DeliveryAttempts.layer.pipe(Layer.provideMerge(baseLayer));
      const apnsProviderTokensLayer = ApnsProviderTokens.layer;
      const apnsClientLayer = ApnsClient.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(baseLayer, apnsProviderTokensLayer)),
      );
      const fcmAssertionSignerLayer = FcmAssertionSigner.layer.pipe(Layer.provideMerge(baseLayer));
      const fcmClientLayer = FcmClient.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(baseLayer, fcmAssertionSignerLayer)),
      );

      const dbContext = yield* Layer.buildWithMemoMap(dbLayer, memoMap, scope);
      const db = Context.get(dbContext, RelayDb.RelayDb);
      const apnsQueueLayer = (
        config.apns
          ? ApnsDeliveryQueue.layerInProcess((job) =>
              PushJobs.enqueue("apns", job.payload.target.deviceId, job).pipe(
                Effect.provideService(RelayDb.RelayDb, db),
              ),
            )
          : ApnsDeliveryQueue.layerNoop
      ).pipe(Layer.provideMerge(baseLayer));
      const fcmSenderLayer = config.fcmServiceAccount
        ? FcmDeliveryQueueSender.layerInProcess((job) =>
            PushJobs.enqueue("fcm", job.deviceId, job).pipe(
              Effect.provideService(RelayDb.RelayDb, db),
            ),
          )
        : FcmDeliveryQueueSender.layerNoop;

      const apnsDeliveriesLayer = ApnsDeliveries.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            baseLayer,
            deliveryAttemptsLayer,
            liveActivitiesLayer,
            apnsQueueLayer,
            apnsClientLayer,
            agentActivityRowsLayer,
          ),
        ),
      );
      const fcmDeliveriesLayer = FcmDeliveries.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            baseLayer,
            fcmSenderLayer,
            fcmClientLayer,
            liveActivitiesLayer,
            agentActivityRowsLayer,
            linksLayer,
          ),
        ),
      );
      const agentActivityPublisherLayer = AgentActivityPublisher.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            baseLayer,
            agentActivityRowsLayer,
            linksLayer,
            liveActivitiesLayer,
            apnsDeliveriesLayer,
            fcmDeliveriesLayer,
          ),
        ),
      );
      const mobileRegistrationsLayer = MobileRegistrations.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            baseLayer,
            agentActivityRowsLayer,
            devicesLayer,
            liveActivitiesLayer,
            agentActivityPublisherLayer,
          ),
        ),
      );

      const hookRateLimiterLayer = Layer.succeed(
        HookForwarder.HookRateLimiter,
        makeHookRateLimiter(db),
      );
      const hookInboxLayer = HookInbox.layerPostgres.pipe(Layer.provideMerge(baseLayer));
      const heldHooksLayer = HeldHooks.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(baseLayer, linksLayer, allocationsLayer, hookInboxLayer)),
      );
      const hookForwarderLayer = HookForwarder.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            baseLayer,
            cloudMintSignerLayer,
            hookRateLimiterLayer,
            hookInboxLayer,
            heldHooksLayer,
          ),
        ),
      );

      // Telemetry stays disabled by default on self-hosted relays (zero Axiom forwarding).
      const disabledMobileTelemetryLayer = Layer.succeed(
        MobileTelemetry.MobileTelemetry,
        MobileTelemetry.MobileTelemetry.of({
          handle: Effect.fn("relay.mobile_telemetry.disabled")(() =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe({ error: "telemetry_disabled" }, { status: 503 }),
            ),
          ),
        }),
      );

      const sharedServicesLayer = Layer.mergeAll(
        baseLayer,
        oidcAuthLayer,
        cloudMintSignerLayer,
        dpopProofsLayer,
        relayTokensLayer,
        linksLayer,
        credentialsLayer,
        allocationsLayer,
        t3ChatLayer,
        tunnelLimitsLayer,
        tunnelRegistryLayer,
        managedEndpointProviderLayer,
        environmentLinkerLayer,
        environmentConnectorLayer,
        publishSignaturesLayer,
        devicesLayer,
        liveActivitiesLayer,
        agentActivityRowsLayer,
        deliveryAttemptsLayer,
        apnsProviderTokensLayer,
        apnsClientLayer,
        fcmAssertionSignerLayer,
        fcmClientLayer,
        apnsQueueLayer,
        fcmSenderLayer,
        apnsDeliveriesLayer,
        fcmDeliveriesLayer,
        agentActivityPublisherLayer,
        mobileRegistrationsLayer,
        hookRateLimiterLayer,
        hookInboxLayer,
        heldHooksLayer,
        hookForwarderLayer,
        disabledMobileTelemetryLayer,
      );

      const sharedContext = yield* Layer.buildWithMemoMap(sharedServicesLayer, memoMap, scope);
      const tunnelRegistry = Context.get(sharedContext, Libp2pTunnelRegistry.Libp2pTunnelRegistry);

      const heldHooks = Context.get(sharedContext, HeldHooks.HeldHooks);
      yield* HookInbox.deliverOne((key) =>
        heldHooks
          .resolveEndpoint(key)
          .pipe(
            Effect.map((endpoint) => (endpoint?.holdWhileOffline ? endpoint.httpBaseUrl : null)),
          ),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Webhook inbox unavailable", { cause }).pipe(Effect.as(false)),
        ),
        Effect.flatMap((worked) => (worked ? Effect.void : Effect.sleep("1 second"))),
        Effect.forever,
        Effect.provideContext(sharedContext),
        Effect.forkIn(scope),
      );
      if (config.apns !== null) {
        const apnsDeliveries = Context.get(sharedContext, ApnsDeliveries.ApnsDeliveries);
        yield* PushJobs.worker("apns", apnsDeliveries.processSignedJob).pipe(
          Effect.provideContext(sharedContext),
          Effect.forkIn(scope),
        );
      }
      if (config.fcmServiceAccount) {
        const fcm = Context.get(sharedContext, FcmDeliveries.FcmDeliveries);
        yield* PushJobs.worker("fcm", fcm.process).pipe(
          Effect.provideContext(sharedContext),
          Effect.forkIn(scope),
        );
      }

      const cleanupStep = Effect.gen(function* () {
        const claimed = yield* db.$client.unsafe(
          `INSERT INTO cove_maintenance AS m VALUES ('cleanup', now()+$1 * interval '1 millisecond')
           ON CONFLICT (task) DO UPDATE SET next_run=excluded.next_run WHERE m.next_run<=now() RETURNING task`,
          [Duration.toMillis(CLEANUP_INTERVAL)],
        );
        if (!claimed.length) return;
        yield* db.$client.unsafe("DELETE FROM cove_held_hooks WHERE expires_at<=now()");
        const now = yield* DateTime.now;
        const terminalCutoff = DateTime.formatIso(
          DateTime.subtract(now, { days: TERMINAL_ACTIVITY_RETENTION_DAYS }),
        );
        const dpop = Context.get(sharedContext, DpopProofs.DpopProofReplay);
        const rows = Context.get(sharedContext, AgentActivityRows.AgentActivityRows);
        const attempts = Context.get(sharedContext, DeliveryAttempts.DeliveryAttempts);
        const publisher = Context.get(sharedContext, AgentActivityPublisher.AgentActivityPublisher);

        yield* db.$client
          .unsafe("DELETE FROM cove_hook_windows WHERE expires_at<now()")
          .pipe(Effect.catchCause(Effect.logWarning));
        yield* dpop.pruneExpired.pipe(
          Effect.catch((error) => Effect.logWarning("Failed to prune DPoP proofs", { error })),
        );
        yield* rows
          .pruneTerminal({ updatedBefore: terminalCutoff })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Failed to prune terminal agent activity rows", { error }),
            ),
          );
        yield* attempts.pruneExpired.pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to prune delivery attempts", { error }),
          ),
        );
        yield* publisher.endIdleLiveActivities.pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to end idle Live Activities", { error }),
          ),
        );
      });

      yield* Effect.sleep(CLEANUP_INTERVAL).pipe(
        Effect.andThen(
          cleanupStep.pipe(
            Effect.catchCause(Effect.logWarning),
            Effect.repeat(Schedule.spaced(CLEANUP_INTERVAL)),
          ),
        ),
        Effect.asVoid,
        Effect.forkIn(scope),
      );

      return { memoMap, sharedContext, tunnelRegistry, config };
    }).pipe(Effect.provide(NodeServices.layer));

    const { memoMap, sharedContext, tunnelRegistry, config } = await Effect.runPromise(bootEffect);

    const sharedContextLayer = Layer.succeedContext(sharedContext);
    const authLayers = Layer.mergeAll(
      RelayHttpApi.layerClientAuth,
      RelayHttpApi.layerEnvironmentAuth,
      RelayHttpApi.layerDpopClientAuth,
    ).pipe(Layer.provide(sharedContextLayer));

    const routeGroupLayers = Layer.mergeAll(
      RelayHttpApi.layerHealthApi,
      RelayHttpApi.layerMetadataApi,
      RelayHttpApi.layerMobileApi,
      RelayHttpApi.layerClientApi,
      RelayHttpApi.layerTokenApi,
      RelayHttpApi.layerDpopClientApi,
      RelayHttpApi.layerServerApi,
      HookForwarder.layerApi,
      MobileTelemetry.layerApi,
    ).pipe(
      Layer.provideMerge(authLayers),
      HttpRouter.provideRequest(sharedContextLayer),
      Layer.provide(sharedContextLayer),
    );

    const httpApiLayer = HttpApiBuilder.layer(RelayApi).pipe(
      Layer.provide(routeGroupLayers),
      Layer.provide(sharedContextLayer),
    );

    const rootRouteLayer = HttpRouter.add(
      "GET",
      "/",
      HttpServerResponse.jsonUnsafe({
        ok: true,
        service: "cove-cp",
        issuer: config.relayIssuer,
        controlPlaneConfig: "/.well-known/cove-control-plane",
      }),
    );

    const httpAppLayer = Layer.mergeAll(
      httpApiLayer,
      rootRouteLayer,
      RelayHttpApi.layerNotFoundRoute,
      RelayHttpApi.layerCors,
    ).pipe(Layer.provide(sharedContextLayer));

    const { handler: webHandler, dispose: disposeWebHandler } = HttpRouter.toWebHandler(
      httpAppLayer,
      {
        memoMap,
        routerConfig: RelayHttpApi.RELAY_HTTP_ROUTER_CONFIG,
      },
    );

    const resolveEndpointKey = (req: NodeHttp.IncomingMessage) => {
      const pathEndpointKey = extractEndpointKeyFromPath(req.url ?? "/");
      if (pathEndpointKey !== null) {
        return { endpointKey: pathEndpointKey, stripPathPrefix: `/t/${pathEndpointKey}` };
      }
      const subdomainKey = extractEndpointKeyFromSubdomainHost(
        req.headers.host,
        config.managedEndpointBaseDomain,
      );
      if (subdomainKey !== null) {
        return { endpointKey: subdomainKey, stripPathPrefix: undefined };
      }
      return null;
    };

    internalGateway.on("request", (req, res) => {
      const match = resolveEndpointKey(req);
      const path = (req.url ?? "").split("?", 1)[0]?.slice(match?.stripPathPrefix?.length ?? 0);
      const control =
        req.method === "POST" &&
        (path === "/api/t3-connect/health" || path === "/api/t3-connect/mint-credential");
      const hook =
        path !== undefined &&
        ["GET", "POST", "PUT", "PATCH"].includes(req.method ?? "") &&
        /^\/api\/hooks\/[^/?#]+\/[^/?#]+$/u.test(path);
      if (!match || (!control && !hook)) {
        res.writeHead(404).end();
        return;
      }
      void tunnelRegistry
        .proxyHttpRequest(
          match.endpointKey,
          req,
          res,
          match.stripPathPrefix ? { stripPathPrefix: match.stripPathPrefix } : {},
        )
        .catch(() => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
    });

    httpServer.on("request", (req, res) => {
      const match = resolveEndpointKey(req);
      if (match) {
        const path = (req.url ?? "").slice(match.stripPathPrefix?.length ?? 0);
        if (req.method === "GET" && path === "/.well-known/cove-tunnel") {
          const online = tunnelRegistry.routes
            ? Effect.runPromise(tunnelRegistry.routes([match.endpointKey])).then(
                (rows) => rows.length > 0,
              )
            : Promise.resolve(tunnelRegistry.isEndpointConnected(match.endpointKey));
          void online.then(
            (ready) => res.writeHead(ready ? 200 : 503).end(),
            () => res.writeHead(503).end(),
          );
        } else {
          res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}');
        }
        return;
      }

      void (async () => {
        try {
          const webRequest = await nodeToWebRequest(req);
          const webResponse = await webHandler(webRequest);
          await writeWebResponseToNode(webResponse, res);
        } catch {
          if (!res.headersSent && !res.writableEnded) {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "internal_server_error" }));
          }
        }
      })();
    });

    httpServer.on("upgrade", (_req, socket: NodeStream.Duplex) => {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });

    return {
      host,
      port: actualPort,
      baseUrl: `http://${connectHost}:${actualPort}`,
      relayIssuer,
      libp2pPeerId: tunnelRegistry.peerId,
      getLibp2pMultiaddrs: () => tunnelRegistry.getMultiaddrs(),
      stop: async () => {
        await Promise.all([closeHttpServer(httpServer), closeHttpServer(internalGateway)]);
        await disposeWebHandler().catch(() => {});
        await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => {});
      },
    };
  } catch (error) {
    await Promise.allSettled([closeHttpServer(httpServer), closeHttpServer(internalGateway)]);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}
