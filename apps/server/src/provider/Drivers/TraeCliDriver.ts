import {
  CodexSettings,
  ProviderDriverKind,
  TextGenerationError,
  TraeCliSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { ProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
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
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  buildServerProvider,
  isWindowsCommandNotFound,
  providerProbeEnvironment,
  isCommandMissingCause,
  resolveProviderProbeTimeoutMs,
  type ProviderProbeResult,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as CodexClient from "effect-codex-app-server/client";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
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
      new TextGenerationError({ operation, detail: "TRAE text generation is not supported." }),
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
  metadata: { displayName: "TRAE", supportsMultipleInstances: true },
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
    const args = traeCliAppServerArgs(config.launchArgs);
    const connect = Effect.fn("TraeCliDriver.connect")(function* (
      child: ChildProcessSpawner.ChildProcessHandle,
      logger?: CodexClient.CodexAppServerClientOptions["logger"],
    ) {
      const context = yield* Layer.build(
        CodexClient.layerChildProcess(child, {
          normalizeIncomingPayload: normalizeTraeCliPayload,
          ...(logger ? { logIncoming: true, logOutgoing: true, logger } : {}),
        }),
      );
      return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context));
    });
    const openClient: CodexAppServerClientFactoryShape["open"] = Effect.fn("TraeCliDriver.open")(
      function* (openInput) {
        const command = yield* makeCodexAppServerSpawnCommand({
          driver: DRIVER,
          command: config.binaryPath,
          args,
          env: openInput.environment,
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
        return yield* connect(child, logger);
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
            detail: "Invalid TRAE runtime settings.",
            cause,
          }),
      ),
    );
    const makeSnapshot = (probe: ProviderProbeResult, models: ReadonlyArray<ServerProviderModel>) =>
      DateTime.now.pipe(
        Effect.map((now) =>
          stampIdentity({
            ...buildServerProvider({
              driver: DRIVER,
              presentation: {
                displayName: "TRAE",
                showInteractionModeToggle: true,
                reportsContextWindow: true,
                supportsConversationRollback: true,
              },
              enabled: config.enabled,
              checkedAt: DateTime.formatIso(now),
              models: traeCliModelsWithCustom(models, config),
              probe,
            }),
            supportsTextGeneration: false,
          }),
        ),
      );
    const initialProbe: ProviderProbeResult = {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
    };
    const checkProvider = Effect.scoped(
      Effect.gen(function* () {
        const env = providerProbeEnvironment(environment);
        const launch = yield* resolveSpawnCommand(config.binaryPath, args, { env });
        const child = yield* spawner.spawn(
          ChildProcess.make(launch.command, launch.args, {
            cwd: host.paths.cwd,
            env,
            shell: launch.shell,
            forceKillAfter: "1 second",
          }),
        );
        const client = yield* connect(child);
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
              detail: "Timed out while checking TRAE provider status.",
            }),
          ),
      }),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const missing =
            isCommandMissingCause(cause) ||
            (cause._tag === "CodexAppServerProcessExitedError" &&
              (yield* isWindowsCommandNotFound(cause.code ?? null, cause.stderr ?? "")));
          return yield* makeSnapshot(
            {
              installed: !missing,
              version: null,
              status: "error",
              auth: { status: "unknown" },
              message: missing
                ? "TRAE executable not found. Check the binary path on this environment."
                : cause._tag === "ProviderDriverError"
                  ? cause.detail
                  : "TRAE provider check failed. Check the CLI on this environment.",
            },
            [],
          );
        }),
      ),
    );
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(config);
    const snapshot = yield* makeManagedServerProvider({
      ...snapshotSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
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
            detail: "Failed to build the TRAE provider.",
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
      continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
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
