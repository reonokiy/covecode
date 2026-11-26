import {
  type ServerProviderAuth,
  type ServerProviderModel,
  type TraeCliSettings,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { providerModelsFromSettings } from "@t3tools/provider-core/server/snapshotProbe";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";

export function normalizeTraeCliPayload(method: string, payload: unknown): unknown {
  if (!Predicate.isObject(payload) || Array.isArray(payload)) return payload;
  if (method === "remoteControl/status/changed") {
    return { serverName: "TRAE", ...payload };
  }
  const normalizeThread = (thread: unknown) =>
    Predicate.isObject(thread) && !Array.isArray(thread) ? { projectId: null, ...thread } : thread;
  if ("thread" in payload) return { ...payload, thread: normalizeThread(payload.thread) };
  if (method === "thread/list" && "data" in payload && Array.isArray(payload.data)) {
    return { ...payload, data: payload.data.map(normalizeThread) };
  }
  return payload;
}

export const traeCliAppServerArgs = (launchArgs: string) => [
  "app-server",
  "--stdio",
  ...tokenizeCliArgs(launchArgs),
];

export function traeCliEnvironment(
  settings: TraeCliSettings,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return { ...environment, ...(settings.homePath ? { TRAE_HOME: settings.homePath } : {}) };
}

const TraeCliAccountResponse = Schema.Struct({
  requiresOpenaiAuth: Schema.Boolean,
  account: Schema.optionalKey(
    Schema.NullOr(
      Schema.Union([
        Schema.Struct({ type: Schema.Literal("trae"), userId: Schema.String }),
        Schema.Struct({ type: Schema.Literal("apiKey") }),
        Schema.Struct({ type: Schema.Literal("chatgpt"), email: Schema.String }),
      ]),
    ),
  ),
});

const decodeAccount = Schema.decodeUnknownEffect(TraeCliAccountResponse);

export const parseTraeCliAccount = Effect.fn("TraeCliProvider.parseAccount")(function* (
  response: unknown,
): Effect.fn.Return<ServerProviderAuth, Schema.SchemaError> {
  const { account, requiresOpenaiAuth } = yield* decodeAccount(response);
  if (!account) {
    return { status: requiresOpenaiAuth ? "unauthenticated" : "unknown" };
  }
  return {
    status: "authenticated",
    type: account.type,
    ...(account.type === "trae" ? { label: account.userId } : {}),
    ...(account.type === "chatgpt" ? { email: account.email } : {}),
  };
});

const TraeCliModelListResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      model: Schema.String,
      displayName: Schema.String,
      isDefault: Schema.Boolean,
      defaultReasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.String)),
      supportedReasoningEfforts: Schema.optionalKey(
        Schema.Array(Schema.Struct({ reasoningEffort: Schema.String, description: Schema.String })),
      ),
    }),
  ),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const decodeModels = Schema.decodeUnknownEffect(TraeCliModelListResponse);

export const parseTraeCliModels = Effect.fn("TraeCliProvider.parseModels")(function* (
  response: unknown,
) {
  const page = yield* decodeModels(response);
  const models: ReadonlyArray<ServerProviderModel> = page.data.map((model) => ({
    slug: model.model,
    name: model.displayName,
    isCustom: false,
    isDefault: model.isDefault,
    supportsTextGeneration: false,
    capabilities: createModelCapabilities({
      optionDescriptors: model.supportedReasoningEfforts?.length
        ? [
            {
              id: "reasoningEffort",
              label: "Reasoning Effort",
              type: "select",
              ...(model.defaultReasoningEffort
                ? { currentValue: model.defaultReasoningEffort }
                : {}),
              options: model.supportedReasoningEfforts.map((effort) => ({
                id: effort.reasoningEffort,
                label: effort.reasoningEffort,
                description: effort.description,
                isDefault: effort.reasoningEffort === model.defaultReasoningEffort,
              })),
            },
          ]
        : [],
    }),
  }));
  return { models, nextCursor: page.nextCursor };
});

export function traeCliModelsWithCustom(
  models: ReadonlyArray<ServerProviderModel>,
  settings: TraeCliSettings,
) {
  const fallback =
    models.find((model) => model.isDefault)?.capabilities ?? models[0]?.capabilities ?? null;
  return providerModelsFromSettings(models, settings.customModels, fallback).map((model) => ({
    ...model,
    supportsTextGeneration: false,
  }));
}
