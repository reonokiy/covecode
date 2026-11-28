import type { LanPeer } from "@t3tools/contracts";
import { isLocalLoopbackHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { EnvironmentHttpServer } from "./EnvironmentHttpServer.ts";
import * as NodeNet from "node:net";
import { ServerConfig } from "../config.ts";
import { allowsRemoteClients } from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

class LanPeerListenError extends Schema.TaggedError<LanPeerListenError>()("LanPeerListenError", {
  cause: Schema.Defect(),
}) {}

export class LanPeerHost extends Context.Service<
  LanPeerHost,
  { readonly getPeer: () => LanPeer | undefined }
>()("t3/environment/LanPeerHost") {}

export const layer = Layer.effect(
  LanPeerHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const policy = yield* ManagedPolicy.ManagedPolicy;
    const bindHost = config.host;
    const wildcard = bindHost === "::" || bindHost === "0.0.0.0";
    const privateInterface =
      bindHost &&
      NodeNet.isIPv4(bindHost) &&
      isPrivateNetworkHost(bindHost) &&
      !isLocalLoopbackHost(bindHost);
    if (!bindHost || !allowsRemoteClients(policy) || !(wildcard || privateInterface)) {
      return { getPeer: () => undefined };
    }
    const path = yield* Path.Path;
    const server = yield* EnvironmentHttpServer;
    const options = {
      bindHost,
      server,
      keyPath: path.join(config.stateDir, "libp2p-lan.key"),
    };
    return yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const { createLanEnvironmentTunnel } = await import("@covecode/libp2p-tunnel");
          return createLanEnvironmentTunnel(options);
        },
        catch: (cause) => new LanPeerListenError({ cause }),
      }),
      (host) => Effect.promise(host.stop),
    );
  }),
).pipe(Layer.provide(ManagedPolicy.layer));
