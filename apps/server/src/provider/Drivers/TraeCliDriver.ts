import {
  CodexSettings,
  ProviderDriverKind,
  ProviderSessionId,
  ThreadId,
  TextGenerationError,
  TraeCliSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { ProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  buildServerProvider,
  isCommandMissingCause,
  resolveProviderProbeTimeoutMs,
  type ProviderProbeResult,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as CodexClient from "effect-codex-app-server/client";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  makeCodexAdapterV2,
  makeCodexAppServerProtocolLogger,
  makeCodexAppServerSpawnCommand,
  type CodexAppServerClientFactoryShape,
} from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ServerConfig from "../../config.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import { buildCodexInitializeParams } from "../CodexProvider.ts";
import {
  parseTraeCliAccount,
  normalizeTraeCliPayload,
  parseTraeCliModels,
  traeCliAppServerArgs,
  traeCliEnvironment,
  traeCliModelsWithCustom,
} from "../TraeCliProvider.ts";

const DRIVER = ProviderDriverKind.make("traecli");
const decodeSettings = Schema.decodeSync(TraeCliSettings);
const decodeAdapterSettings = Schema.decodeEffect(CodexSettings);
const unsupportedTextGeneration: ProviderTextGeneration = (() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({ operation, detail: "TRAE CLI text generation is not supported." }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
    generateTranscriptionPostProcessing: () => unsupported("generateTranscriptionPostProcessing"),
  };
})();

export type TraeCliDriverEnv =
  | ProviderHost.ProviderHost
  | ProviderEventLoggers.ProviderEventLoggers
  | McpProviderSessions.McpProviderSessions
  | IdAllocator.IdAllocatorV2
  | Digest.Digest
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | ServerConfig.ServerConfig
  | PortScanner.PortDiscovery;

export const TraeCliDriver: ProviderDriver<TraeCliSettings, TraeCliDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "TRAE CLI", supportsMultipleInstances: true },
  configSchema: TraeCliSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("TraeCliDriver.create")(function* (input) {
    const host = yield* ProviderHost.ProviderHost;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const digest = yield* Digest.Digest;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const portDiscovery = yield* PortScanner.PortDiscovery;
    const loggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const processEnvironment = yield* mergeProviderInstanceEnvironment(
      input.environment,
      yield* HostProcess.Environment,
    );
    const config = {
      ...input.config,
      enabled: input.enabled,
      binaryPath: expandHomePath(input.config.binaryPath, homeDirectory),
      homePath: expandHomePath(
        input.config.homePath || processEnvironment.TRAE_HOME || path.join(homeDirectory, ".trae"),
        homeDirectory,
      ),
    };
    const environment = traeCliEnvironment(config, processEnvironment);
    const continuationIdentity = {
      driverKind: DRIVER,
      continuationKey: `traecli:home:${config.homePath}`,
    };
    const stampIdentity = withInstanceIdentity({
      instanceId: input.instanceId,
      driverKind: DRIVER,
      displayName: input.displayName,
      accentColor: input.accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const openClient: CodexAppServerClientFactoryShape["open"] = Effect.fn("TraeCliDriver.open")(
      function* (openInput) {
        const command = yield* makeCodexAppServerSpawnCommand({
          driver: DRIVER,
          command: config.binaryPath,
          args: traeCliAppServerArgs(config.launchArgs),
          env: environment,
          cwd: openInput.runtimePolicy.cwd ?? host.paths.cwd,
          threadId: openInput.threadId,
        });
        const child = yield* spawner.spawn(command);
        yield* Effect.acquireRelease(Effect.sync(portDiscovery.trackAgent), (release) =>
          Effect.sync(release),
        );
        const logger = makeCodexAppServerProtocolLogger({
          driver: DRIVER,
          nativeEventLogger: loggers.native,
          providerSessionId: openInput.providerSessionId,
        });
        const context = yield* Layer.build(
          CodexClient.layerChildProcess(child, {
            normalizeIncomingPayload: normalizeTraeCliPayload,
            ...(logger ? { logIncoming: true, logOutgoing: true, logger } : {}),
          }),
        );
        return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.provide(context),
        );
      },
      (effect, openInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: DRIVER,
                providerSessionId: openInput.providerSessionId,
                cause,
              }),
          ),
        ),
    );
    const adapterSettings = yield* decodeAdapterSettings({ ...config, shadowHomePath: "" }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId: input.instanceId,
            detail: "Invalid TRAE CLI runtime settings.",
            cause,
          }),
      ),
    );
    const makeSnapshot = (probe: ProviderProbeResult, models: ReadonlyArray<ServerProviderModel>) =>
      DateTime.now.pipe(
        Effect.map((now) =>
          stampIdentity(
            buildServerProvider({
              driver: DRIVER,
              presentation: {
                displayName: "TRAE CLI",
                showInteractionModeToggle: true,
                reportsContextWindow: true,
                supportsConversationRollback: true,
              },
              enabled: config.enabled,
              checkedAt: DateTime.formatIso(now),
              models: traeCliModelsWithCustom(models, config),
              probe,
            }),
          ),
        ),
      );
    const initialProbe: ProviderProbeResult = {
      installed: false,
      version: null,
      status: "ready",
      auth: { status: "unknown" },
    };
    const checkProvider = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* openClient({
          instanceId: input.instanceId,
          threadId: ThreadId.make("traecli-probe"),
          providerSessionId: ProviderSessionId.make("traecli-probe"),
          runtimePolicy: {
            cwd: host.paths.cwd,
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
          settings: adapterSettings,
          environment,
        });
        const initialized = yield* client.request("initialize", buildCodexInitializeParams());
        yield* client.notify("initialized", undefined);
        const auth = yield* client.raw
          .request("account/read", {})
          .pipe(Effect.flatMap(parseTraeCliAccount));
        const models: ServerProviderModel[] = [];
        let cursor: string | null | undefined;
        do {
          const page = yield* client.raw
            .request("model/list", cursor ? { cursor } : {})
            .pipe(Effect.flatMap(parseTraeCliModels));
          models.push(...page.models);
          cursor = page.nextCursor;
        } while (cursor);
        return yield* makeSnapshot(
          {
            installed: true,
            version: /\/(\d+\.\d+\.\d+(?:-[\w.-]+)?)/u.exec(initialized.userAgent)?.[1] ?? null,
            status: auth.status === "unauthenticated" ? "error" : "ready",
            auth,
            ...(auth.status === "unauthenticated"
              ? { message: "Run traecli login on this environment to sign in." }
              : {}),
          },
          models,
        );
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: resolveProviderProbeTimeoutMs(DRIVER, 20_000, environment),
        orElse: () =>
          Effect.fail(
            new ProviderDriverError({
              driver: DRIVER,
              instanceId: input.instanceId,
              detail: "Timed out while checking TRAE CLI provider status.",
            }),
          ),
      }),
      Effect.catch((cause) =>
        makeSnapshot(
          {
            installed: !isCommandMissingCause(cause),
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message: `TRAE CLI provider check failed: ${String(cause)}`,
          },
          [],
        ),
      ),
    );
    const snapshot = yield* makeManagedServerProvider({
      getSettings: Effect.succeed(config),
      streamSettings: Stream.empty,
      haveSettingsChanged: () => false,
      initialSnapshot: () => makeSnapshot(initialProbe, []),
      checkProvider: config.enabled ? checkProvider : makeSnapshot(initialProbe, []),
      resolveMaintenance: () =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER,
            packageName: null,
            manualCommand: "traecli update",
          }),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId: input.instanceId,
            detail: "Failed to build the TRAE CLI provider.",
            cause,
          }),
      ),
    );
    const orchestrationAdapter = yield* makeCodexAdapterV2({
      driver: DRIVER,
      instanceId: input.instanceId,
      settings: adapterSettings,
      environment,
      clientFactory: { open: openClient },
      models: snapshot.getSnapshot.pipe(Effect.map((current) => current.models)),
      digest,
      fileSystem,
      idAllocator,
      serverConfig,
      watchCommandStops: portDiscovery.watchAgentCommandStops,
    });
    return {
      instanceId: input.instanceId,
      driverKind: DRIVER,
      continuationIdentity,
      displayName: input.displayName,
      accentColor: input.accentColor,
      enabled: input.enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration: unsupportedTextGeneration,
    } satisfies ProviderInstance;
  }),
};
