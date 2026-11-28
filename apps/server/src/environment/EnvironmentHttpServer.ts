// @effect-diagnostics nodeBuiltinImport:off -- Peer streams enter the same Node request and upgrade handlers as TCP.
import type * as NodeHttp from "node:http";
import * as Context from "effect/Context";

export class EnvironmentHttpServer extends Context.Service<
  EnvironmentHttpServer,
  NodeHttp.Server
>()("t3/environment/EnvironmentHttpServer") {}
