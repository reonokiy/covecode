import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, TraeCliSettings } from "@t3tools/contracts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "../../config.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import { TraeCliDriver } from "./TraeCliDriver.ts";

const config = Schema.decodeSync(TraeCliSettings)({ homePath: "/accounts/trae" });
const dependencies = Layer.mergeAll(
  TestProviderHost.layer({ runBackgroundWork: false }),
  IdAllocator.layer,
  McpProviderSessions.layer,
  PortScanner.layerTest,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-trae-driver-" }),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

it.layer(dependencies)("TraeCliDriver", (it) => {
  it.effect("keeps disabled instances offline and binds continuation to the TRAE home", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("traecli-work");
      const provider = yield* TraeCliDriver.create({
        instanceId,
        displayName: undefined,
        environment: [],
        enabled: false,
        config,
      });
      const snapshot = yield* provider.snapshot.refresh;
      assert.equal(snapshot.status, "disabled");
      assert.equal(snapshot.instanceId, instanceId);
      assert.equal(snapshot.driver, "traecli");
      assert.equal(provider.orchestrationAdapter.driver, "traecli");
      assert.equal(provider.continuationIdentity.driverKind, "traecli");
      assert.equal(provider.continuationIdentity.continuationKey, "traecli:home:/accounts/trae");
      const other = yield* TraeCliDriver.create({
        instanceId: ProviderInstanceId.make("traecli-personal"),
        displayName: undefined,
        environment: [],
        enabled: false,
        config: { ...config, homePath: "/accounts/personal" },
      });
      assert.notEqual(
        other.continuationIdentity.continuationKey,
        provider.continuationIdentity.continuationKey,
      );
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("Disabled TRAE CLI must not spawn a process")),
      ),
    ),
  );
});
