import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Result from "effect/Result";

import {
  hostedAppUrlConfig,
  makeRelayUrlConfig,
  makeResolveCloudCliOidcConfig,
  resolveRelayClientTracingConfig,
} from "./publicConfig.ts";

const provideEnv = (env: Readonly<Record<string, string>>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

it.effect("rejects a non-loopback HTTP runtime relay URL override", () =>
  makeRelayUrlConfig("https://embedded.example.test").pipe(
    provideEnv({ T3CODE_RELAY_URL: "http://runtime.example.test" }),
    Effect.flip,
  ),
);

it.effect("accepts a loopback HTTP runtime relay URL override", () =>
  Effect.gen(function* () {
    const resolved = yield* makeRelayUrlConfig("https://embedded.example.test").pipe(
      provideEnv({ T3CODE_RELAY_URL: "http://127.0.0.1:8787/" }),
    );
    assert.equal(resolved, "http://127.0.0.1:8787");
  }),
);

it.effect("rejects malformed or insecure hosted app URLs", () =>
  Effect.gen(function* () {
    for (const value of [
      "app.t3.codes",
      "http://app.t3.codes",
      "https://app.t3.codes/nested",
      "https://app.t3.codes?alias=true",
    ]) {
      const result = yield* hostedAppUrlConfig.pipe(
        provideEnv({ T3CODE_HOSTED_APP_URL: value }),
        Effect.result,
      );
      assert.isTrue(Result.isFailure(result), value);
    }
  }),
);

it.effect("resolves CLI OIDC endpoints via explicit env issuer and OIDC discovery", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];
    const httpClient = HttpClient.make((request) => {
      requests.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            issuer: "https://idp.example.test/realms/cove",
            authorization_endpoint: "https://idp.example.test/realms/cove/auth",
            token_endpoint: "https://idp.example.test/realms/cove/token",
            device_authorization_endpoint: "https://idp.example.test/realms/cove/device",
            jwks_uri: "https://idp.example.test/realms/cove/jwks",
          }),
        ),
      );
    });

    const config = yield* makeResolveCloudCliOidcConfig().pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      provideEnv({
        T3CODE_OIDC_ISSUER: "https://idp.example.test/realms/cove/",
        T3CODE_OIDC_CLIENT_ID: "cove-cli",
        T3CODE_OIDC_AUDIENCE: "cove-relay",
        T3CODE_OIDC_SCOPES: "openid profile email",
      }),
    );

    assert.deepEqual(requests, [
      "https://idp.example.test/realms/cove/.well-known/openid-configuration",
    ]);
    assert.deepEqual(config, {
      issuer: "https://idp.example.test/realms/cove",
      clientId: "cove-cli",
      audience: "cove-relay",
      authorizationEndpoint: "https://idp.example.test/realms/cove/auth",
      tokenEndpoint: "https://idp.example.test/realms/cove/token",
      deviceAuthorizationEndpoint: "https://idp.example.test/realms/cove/device",
      loopbackPort: 34338,
      redirectUri: "http://127.0.0.1:34338/callback",
      scopes: ["openid", "profile", "email"],
    });
  }),
);

it.effect("auto-discovers CLI OIDC config from the control plane when env vars are unset", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];
    const httpClient = HttpClient.make((request) => {
      requests.push(request.url);
      if (request.url === "https://relay.example.test/.well-known/cove-control-plane") {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              controlPlaneUrl: "https://relay.example.test",
              oidc: {
                issuer: "https://idp.example.test",
                clientId: "cove-public-client",
                audience: null,
                scopes: ["openid", "email", "offline_access"],
              },
              libp2p: {
                enabled: true,
                peerId: null,
                relayMultiaddrs: [],
              },
            }),
          ),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            issuer: "https://idp.example.test",
            authorization_endpoint: "https://idp.example.test/authorize",
            token_endpoint: "https://idp.example.test/token",
            jwks_uri: "https://idp.example.test/jwks",
          }),
        ),
      );
    });

    const config = yield* makeResolveCloudCliOidcConfig().pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      provideEnv({ T3CODE_RELAY_URL: "https://relay.example.test" }),
    );

    assert.deepEqual(requests, [
      "https://relay.example.test/.well-known/cove-control-plane",
      "https://idp.example.test/.well-known/openid-configuration",
    ]);
    assert.deepEqual(config, {
      issuer: "https://idp.example.test",
      clientId: "cove-public-client",
      authorizationEndpoint: "https://idp.example.test/authorize",
      tokenEndpoint: "https://idp.example.test/token",
      loopbackPort: 34338,
      redirectUri: "http://127.0.0.1:34338/callback",
      scopes: ["openid", "email", "offline_access"],
    });
  }),
);

it.effect("rejects OIDC discovery documents whose issuer does not match", () =>
  Effect.gen(function* () {
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            issuer: "https://other.example.test",
            authorization_endpoint: "https://idp.example.test/auth",
            token_endpoint: "https://idp.example.test/token",
            jwks_uri: "https://idp.example.test/jwks",
          }),
        ),
      ),
    );

    const error = yield* makeResolveCloudCliOidcConfig({
      issuerFallback: "https://idp.example.test",
      clientIdFallback: "cove-cli",
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), provideEnv({}), Effect.flip);

    assert.include(error.message, "did not match expected");
  }),
);

it("relay tracing is disabled by default and requires explicit opt-in", () => {
  const fallback = {
    tracesUrl: "https://embedded.example.test/v1/traces",
    tracesDataset: "embedded-dataset",
    tracesToken: "embedded-token",
  };
  const runtimeCredentials = {
    T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://runtime.example.test/v1/traces",
    T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "runtime-dataset",
    T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "runtime-token",
  };

  assert.equal(resolveRelayClientTracingConfig({}, fallback), null);
  assert.equal(resolveRelayClientTracingConfig(runtimeCredentials, fallback), null);
  assert.deepEqual(
    resolveRelayClientTracingConfig({ T3CODE_TELEMETRY_ENABLED: "true" }, fallback),
    fallback,
  );
  assert.deepEqual(
    resolveRelayClientTracingConfig(
      { T3CODE_TELEMETRY_ENABLED: "true", ...runtimeCredentials },
      fallback,
    ),
    {
      tracesUrl: "https://runtime.example.test/v1/traces",
      tracesDataset: "runtime-dataset",
      tracesToken: "runtime-token",
    },
  );
});

it("product opt-out disables relay tracing with either built-in or runtime credentials", () => {
  const fallback = {
    tracesUrl: "https://embedded.example.test/v1/traces",
    tracesDataset: "embedded-dataset",
    tracesToken: "embedded-token",
  };
  const env = {
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "false",
  };

  assert.equal(resolveRelayClientTracingConfig(env, fallback), null);
  assert.equal(
    resolveRelayClientTracingConfig(
      {
        ...env,
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://runtime.example.test/v1/traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "runtime-dataset",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "runtime-token",
      },
      fallback,
    ),
    null,
  );
});
