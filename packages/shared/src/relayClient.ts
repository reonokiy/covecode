import {
  type RelayClientInstallFailureReason,
  RelayClientInstallFailureReasonSchema,
  type RelayClientInstallProgressEvent,
  type RelayClientInstallProgressStage,
  type RelayClientStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export type {
  RelayClientInstallFailureReason,
  RelayClientInstallProgressEvent,
  RelayClientInstallProgressStage,
  RelayClientStatus,
};

export const BUILTIN_RELAY_CLIENT_VERSION = "libp2p-v3";
export const BUILTIN_RELAY_CLIENT_PATH = "builtin:libp2p";

export type RelayClientExecutableSource = "override" | "managed" | "path";
export type AvailableRelayClient = Extract<RelayClientStatus, { readonly status: "available" }>;

export class RelayClientInstallError extends Schema.TaggedError<RelayClientInstallError>()(
  "RelayClientInstallError",
  {
    reason: RelayClientInstallFailureReasonSchema,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface RelayClientShape {
  readonly resolve: Effect.Effect<RelayClientStatus>;
  readonly install: Effect.Effect<AvailableRelayClient, RelayClientInstallError>;
  readonly installWithProgress: (
    onEvent: (event: RelayClientInstallProgressEvent) => Effect.Effect<void>,
  ) => Effect.Effect<AvailableRelayClient, RelayClientInstallError>;
}

export class RelayClient extends Context.Service<RelayClient, RelayClientShape>()(
  "@t3tools/shared/relayClient",
) {}

export function isPinnedManagedRelayClient(executable: AvailableRelayClient): boolean {
  return executable.source === "managed" && executable.version === BUILTIN_RELAY_CLIENT_VERSION;
}

const BUILTIN_AVAILABLE_CLIENT: AvailableRelayClient = {
  status: "available",
  executablePath: BUILTIN_RELAY_CLIENT_PATH,
  source: "managed",
  version: BUILTIN_RELAY_CLIENT_VERSION,
};

export const layerBuiltinLibp2p: Layer.Layer<RelayClient> = Layer.succeed(
  RelayClient,
  RelayClient.of({
    resolve: Effect.succeed(BUILTIN_AVAILABLE_CLIENT),
    install: Effect.succeed(BUILTIN_AVAILABLE_CLIENT),
    installWithProgress: Effect.fn("RelayClient.installWithProgress")(function* (onEvent) {
      yield* onEvent({
        type: "complete",
        status: BUILTIN_AVAILABLE_CLIENT,
      });
      return BUILTIN_AVAILABLE_CLIENT;
    }),
  }),
);
