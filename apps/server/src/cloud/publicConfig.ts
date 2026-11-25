import { RelayControlPlanePublicConfig } from "@t3tools/contracts/relay";
import { connectLoopbackRedirectUri, DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import {
  DEFAULT_OIDC_SCOPES,
  normalizeOidcIssuer,
  OidcDiscoveryDocument,
  oidcDiscoveryUrl,
} from "@t3tools/shared/oidc";
import { isRelayTracingEnabled } from "@t3tools/shared/otelEnvironment";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

declare const __T3CODE_BUILD_RELAY_URL__: string | undefined;
declare const __T3CODE_BUILD_CHANNEL__: "nightly" | "latest" | undefined;
declare const __T3CODE_BUILD_OIDC_ISSUER__: string | undefined;
declare const __T3CODE_BUILD_OIDC_CLIENT_ID__: string | undefined;
declare const __T3CODE_BUILD_OIDC_AUDIENCE__: string | undefined;
declare const __T3CODE_BUILD_OIDC_SCOPES__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: string | undefined;

const CLOUD_CLI_OAUTH_LOOPBACK_PORT = 34338;
const DISCOVERY_TIMEOUT = Duration.seconds(10);

function configError(message: string, cause?: unknown): Config.ConfigError {
  return cause === undefined
    ? new Config.ConfigError(new Schema.SchemaError(new SchemaIssue.InvalidValue({ message })))
    : new Config.ConfigError(new ConfigProvider.SourceError({ message, cause }));
}

function validateRelayUrl(value: string): Effect.Effect<string, Config.ConfigError> {
  const relayUrl = normalizeSecureRelayUrl(value);
  return relayUrl === null
    ? Effect.fail(configError("Relay URL must be a secure HTTPS or loopback HTTP origin."))
    : Effect.succeed(relayUrl);
}

function readBuildTimeValue(value: string | undefined): string {
  return typeof value === "undefined" ? "" : value.trim();
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const buildTimeRelayUrl =
  typeof __T3CODE_BUILD_RELAY_URL__ === "undefined"
    ? ""
    : (normalizeSecureRelayUrl(__T3CODE_BUILD_RELAY_URL__) ?? "");
const buildTimeOidcIssuer = readBuildTimeValue(
  typeof __T3CODE_BUILD_OIDC_ISSUER__ === "undefined" ? undefined : __T3CODE_BUILD_OIDC_ISSUER__,
);
const buildTimeOidcClientId = readBuildTimeValue(
  typeof __T3CODE_BUILD_OIDC_CLIENT_ID__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_OIDC_CLIENT_ID__,
);
const buildTimeOidcAudience = readBuildTimeValue(
  typeof __T3CODE_BUILD_OIDC_AUDIENCE__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_OIDC_AUDIENCE__,
);
const buildTimeOidcScopes = readBuildTimeValue(
  typeof __T3CODE_BUILD_OIDC_SCOPES__ === "undefined" ? undefined : __T3CODE_BUILD_OIDC_SCOPES__,
);
const buildTimeRelayClientTracing = {
  tracesUrl: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__,
  ),
  tracesDataset: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__,
  ),
  tracesToken: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__,
  ),
} as const;

export function resolveRelayClientTracingConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallback = buildTimeRelayClientTracing,
) {
  if (!isRelayTracingEnabled(env)) {
    return null;
  }

  const tracesUrl = env.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() || fallback.tracesUrl;
  const tracesDataset =
    env.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() || fallback.tracesDataset;
  const tracesToken = env.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() || fallback.tracesToken;
  const normalizedTracesUrl = normalizeSecureUrl(tracesUrl);
  return normalizedTracesUrl && tracesDataset && tracesToken
    ? { tracesUrl: normalizedTracesUrl, tracesDataset, tracesToken }
    : null;
}

export function makeRelayUrlConfig(fallback = buildTimeRelayUrl) {
  const runtimeConfig = Config.NonEmptyString("T3CODE_RELAY_URL");
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.mapEffect(validateRelayUrl),
  );
}

export const relayUrlConfig = makeRelayUrlConfig();

export const hostedAppUrlConfig = makePublicValueConfig(
  "T3CODE_HOSTED_APP_URL",
  DEFAULT_HOSTED_APP_URL,
).pipe(Config.mapEffect(validateHostedAppUrl));

const NIGHTLY_HOSTED_APP_URL = "https://nightly.app.t3.codes";

/**
 * Where agent sign-ins on the T3 Connect address are approved. A nightly build defaults to the
 * nightly hosted app, which ships the same approval page; app.t3.codes serves stable.
 */
export const agentApprovalAppUrlConfig = makePublicValueConfig(
  "T3CODE_HOSTED_APP_URL",
  typeof __T3CODE_BUILD_CHANNEL__ !== "undefined" && __T3CODE_BUILD_CHANNEL__ === "nightly"
    ? NIGHTLY_HOSTED_APP_URL
    : DEFAULT_HOSTED_APP_URL,
).pipe(Config.mapEffect(validateHostedAppUrl));

function validateHostedAppUrl(value: string) {
  try {
    const url = new URL(value);
    const isLoopbackHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (
      (url.protocol !== "https:" && !isLoopbackHttp) ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid hosted app origin");
    }
    return Effect.succeed(url.origin);
  } catch {
    return Effect.fail(
      configError("Hosted app URL must be an absolute HTTPS origin (or HTTP loopback origin)."),
    );
  }
}

function makePublicValueConfig(name: string, fallback: string) {
  const runtimeConfig = Config.NonEmptyString(name);
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.map((value) => value.trim()),
  );
}

function makeOptionalValueConfig(name: string, fallback: string) {
  return Config.String(name).pipe(
    Config.option,
    Config.map((value) => {
      const resolved = Option.getOrElse(value, () => fallback).trim();
      return resolved.length > 0 ? resolved : undefined;
    }),
  );
}

function parseScopes(raw: string | undefined): ReadonlyArray<string> | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .trim()
    .split(/\s+/u)
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : undefined;
}

export interface CloudCliOidcEndpoints {
  readonly issuer: string;
  readonly clientId: string;
  readonly audience?: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint?: string;
  readonly loopbackPort: number;
  readonly redirectUri: string;
  readonly scopes: ReadonlyArray<string>;
}

export interface ResolveCloudCliOidcConfigOverrides {
  readonly relayUrl?: string;
  readonly relayUrlFallback?: string;
  readonly issuerFallback?: string;
  readonly clientIdFallback?: string;
  readonly audienceFallback?: string;
  readonly scopesFallback?: string;
}

export const makeResolveCloudCliOidcConfig = Effect.fn("CloudPublicConfig.resolveCliOidcConfig")(
  function* (overrides: ResolveCloudCliOidcConfigOverrides = {}) {
    const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

    const {
      issuer: envIssuer,
      clientId: envClientId,
      audience: envAudience,
      scopes: envScopesRaw,
    } = yield* Config.all({
      issuer: makeOptionalValueConfig(
        "T3CODE_OIDC_ISSUER",
        overrides.issuerFallback ?? buildTimeOidcIssuer,
      ),
      clientId: makeOptionalValueConfig(
        "T3CODE_OIDC_CLIENT_ID",
        overrides.clientIdFallback ?? buildTimeOidcClientId,
      ),
      audience: makeOptionalValueConfig(
        "T3CODE_OIDC_AUDIENCE",
        overrides.audienceFallback ?? buildTimeOidcAudience,
      ),
      scopes: makeOptionalValueConfig(
        "T3CODE_OIDC_SCOPES",
        overrides.scopesFallback ?? buildTimeOidcScopes,
      ),
    });

    let issuer = envIssuer;
    let clientId = envClientId;
    let audience = envAudience;
    let scopes = parseScopes(envScopesRaw);

    if (issuer === undefined || clientId === undefined) {
      const relayUrl =
        overrides.relayUrl !== undefined
          ? yield* validateRelayUrl(overrides.relayUrl)
          : yield* makeRelayUrlConfig(overrides.relayUrlFallback ?? buildTimeRelayUrl);
      const controlPlane = yield* httpClient.get(`${relayUrl}/.well-known/cove-control-plane`).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayControlPlanePublicConfig)),
        Effect.scoped,
        Effect.timeout(DISCOVERY_TIMEOUT),
        Effect.mapError((cause) =>
          configError(
            `Failed to load OIDC configuration from control plane ${relayUrl}/.well-known/cove-control-plane.`,
            cause,
          ),
        ),
      );
      if (controlPlane.oidc === null) {
        return yield* Effect.fail(
          configError(
            `Control plane ${relayUrl} does not have OIDC configured and T3CODE_OIDC_ISSUER / T3CODE_OIDC_CLIENT_ID are unset.`,
          ),
        );
      }
      issuer ??= controlPlane.oidc.issuer;
      clientId ??= controlPlane.oidc.clientId;
      audience ??= controlPlane.oidc.audience ?? undefined;
      if (scopes === undefined && controlPlane.oidc.scopes.length > 0) {
        scopes = controlPlane.oidc.scopes;
      }
    }

    const normalizedIssuer = normalizeOidcIssuer(issuer);
    const discoveryUrl = oidcDiscoveryUrl(normalizedIssuer);
    const discovery = yield* httpClient.get(discoveryUrl).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(OidcDiscoveryDocument)),
      Effect.scoped,
      Effect.timeout(DISCOVERY_TIMEOUT),
      Effect.mapError((cause) =>
        configError(`Failed to fetch OIDC discovery document from ${discoveryUrl}.`, cause),
      ),
    );
    if (normalizeOidcIssuer(discovery.issuer) !== normalizedIssuer) {
      return yield* Effect.fail(
        configError(
          `OIDC discovery issuer "${discovery.issuer}" did not match expected "${normalizedIssuer}".`,
        ),
      );
    }

    return {
      issuer: normalizedIssuer,
      clientId,
      ...(audience !== undefined && audience.length > 0 ? { audience } : {}),
      authorizationEndpoint: discovery.authorization_endpoint,
      tokenEndpoint: discovery.token_endpoint,
      ...(discovery.device_authorization_endpoint !== undefined
        ? { deviceAuthorizationEndpoint: discovery.device_authorization_endpoint }
        : {}),
      loopbackPort: CLOUD_CLI_OAUTH_LOOPBACK_PORT,
      redirectUri: connectLoopbackRedirectUri(CLOUD_CLI_OAUTH_LOOPBACK_PORT),
      scopes: scopes ?? [...DEFAULT_OIDC_SCOPES],
    } satisfies CloudCliOidcEndpoints;
  },
);

export const resolveCloudCliOidcConfig = makeResolveCloudCliOidcConfig();

export const hasCloudPublicConfig = Boolean(
  normalizeSecureRelayUrl(process.env.T3CODE_RELAY_URL ?? "") ?? buildTimeRelayUrl,
);
