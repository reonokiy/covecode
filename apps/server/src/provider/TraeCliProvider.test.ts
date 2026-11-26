import { TraeCliSettings } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  parseTraeCliAccount,
  parseTraeCliModels,
  normalizeTraeCliPayload,
  traeCliAppServerArgs,
  traeCliEnvironment,
  traeCliModelsWithCustom,
} from "./TraeCliProvider.ts";

const decodeSettings = Schema.decodeSync(TraeCliSettings);
const customSettings = decodeSettings({ customModels: ["custom-model"] });

describe("TRAE CLI native protocol", () => {
  it("adds only missing shared-protocol metadata without changing native identity", () => {
    const thread = { id: "native-trae-thread", turns: [] };
    assert.deepEqual(normalizeTraeCliPayload("thread/start", { thread }), {
      thread: { ...thread, projectId: null },
    });
    assert.deepEqual(
      normalizeTraeCliPayload("thread/started", {
        thread: { ...thread, projectId: "native-project" },
      }),
      { thread: { ...thread, projectId: "native-project" } },
    );
    assert.deepEqual(normalizeTraeCliPayload("thread/list", { data: [thread], nextCursor: null }), {
      data: [{ ...thread, projectId: null }],
      nextCursor: null,
    });
    assert.deepEqual(
      normalizeTraeCliPayload("remoteControl/status/changed", {
        installationId: "trae",
        status: "disabled",
      }),
      { installationId: "trae", status: "disabled", serverName: "TRAE CLI" },
    );
    assert.strictEqual(normalizeTraeCliPayload("turn/start", null), null);
  });
  it("launches app-server over stdio and keeps the TRAE home separate", () => {
    const settings = decodeSettings({ homePath: "/accounts/trae" });
    assert.deepEqual(traeCliAppServerArgs('-c "model=gpt 5"'), [
      "app-server",
      "--stdio",
      "-c",
      "model=gpt 5",
    ]);
    assert.deepEqual(
      traeCliEnvironment(settings, {
        CODEX_HOME: "/accounts/codex",
        TRAE_HOME: "/old",
        PATH: "/bin",
      }),
      {
        CODEX_HOME: "/accounts/codex",
        TRAE_HOME: "/accounts/trae",
        PATH: "/bin",
      },
    );
    assert.equal(settings.binaryPath, "traecli");
  });

  it.effect.each([
    {
      account: { type: "trae", userId: "trae-user" },
      expected: { status: "authenticated", type: "trae", label: "trae-user" },
    },
    { account: { type: "apiKey" }, expected: { status: "authenticated", type: "apiKey" } },
    { account: null, expected: { status: "unauthenticated" } },
  ] as const)("reads native account $account", ({ account, expected }) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* parseTraeCliAccount({ requiresOpenaiAuth: true, account }), expected);
      assert.deepEqual(yield* parseTraeCliAccount({ requiresOpenaiAuth: false }), {
        status: "unknown",
      });
    }),
  );

  it.effect("keeps native model defaults, effort choices, and pagination", () =>
    Effect.gen(function* () {
      const page = yield* parseTraeCliModels({
        data: [
          {
            model: "seed-code",
            displayName: "Seed Code",
            isDefault: true,
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Quick" },
              { reasoningEffort: "high", description: "Thorough" },
            ],
            traeBusiness: { backendVariants: ["native"] },
          },
        ],
        nextCursor: "page-2",
      });
      assert.equal(page.nextCursor, "page-2");
      const model = page.models[0]!;
      assert.equal(model.slug, "seed-code");
      assert.isTrue(model.isDefault);
      assert.deepEqual(model.capabilities?.optionDescriptors?.[0], {
        id: "reasoningEffort",
        label: "Reasoning Effort",
        type: "select",
        currentValue: "high",
        options: [
          { id: "low", label: "low", description: "Quick", isDefault: false },
          { id: "high", label: "high", description: "Thorough", isDefault: true },
        ],
      });
      const models = traeCliModelsWithCustom(page.models, customSettings);
      assert.deepEqual(
        models.map((entry) => entry.supportsTextGeneration),
        [false, false],
      );
    }),
  );
});
