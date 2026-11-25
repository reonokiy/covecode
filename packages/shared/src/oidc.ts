import { sha256 } from "@noble/hashes/sha2";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as JoseError from "effect/jose/JoseError";
import * as Jwk from "effect/jose/Jwk";
import * as Jwks from "effect/jose/Jwks";
import * as Jwt from "effect/jose/Jwt";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export const DEFAULT_OIDC_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

const DEFAULT_OIDC_ALLOWED_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const satisfies ReadonlyArray<Jwk.AsymmetricAlgorithm>;

const NonEmptyString = Schema.String.check(Schema.isNonEmpty());

export const OidcDiscoveryDocument = Schema.Struct({
  issuer: NonEmptyString,
  authorization_endpoint: NonEmptyString,
  token_endpoint: NonEmptyString,
  jwks_uri: NonEmptyString,
  userinfo_endpoint: Schema.optionalKey(NonEmptyString),
  end_session_endpoint: Schema.optionalKey(NonEmptyString),
  device_authorization_endpoint: Schema.optionalKey(NonEmptyString),
  revocation_endpoint: Schema.optionalKey(NonEmptyString),
  scopes_supported: Schema.optionalKey(Schema.Array(Schema.String)),
  code_challenge_methods_supported: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type OidcDiscoveryDocument = typeof OidcDiscoveryDocument.Type;

export const OidcTokenResponse = Schema.Struct({
  access_token: NonEmptyString,
  token_type: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
  refresh_token: Schema.optionalKey(NonEmptyString),
  id_token: Schema.optionalKey(NonEmptyString),
  scope: Schema.optionalKey(Schema.String),
});
export type OidcTokenResponse = typeof OidcTokenResponse.Type;

export const OidcDeviceAuthorizationResponse = Schema.Struct({
  device_code: NonEmptyString,
  user_code: NonEmptyString,
  verification_uri: NonEmptyString,
  verification_uri_complete: Schema.optionalKey(NonEmptyString),
  expires_in: Schema.Number,
  interval: Schema.optionalKey(Schema.Number),
});
export type OidcDeviceAuthorizationResponse = typeof OidcDeviceAuthorizationResponse.Type;

export interface OidcVerifiedPrincipal {
  readonly subject: string;
  readonly issuer: string;
  readonly email?: string | undefined;
  readonly emailVerified?: boolean | undefined;
  readonly name?: string | undefined;
  readonly preferredUsername?: string | undefined;
  readonly picture?: string | undefined;
  readonly claims: Readonly<Record<string, Schema.Json>>;
}

export class OidcError extends Schema.TaggedError<OidcError>()("OidcError", {
  operation: Schema.Literals([
    "discovery",
    "token_exchange",
    "token_refresh",
    "device_authorization",
    "device_token",
    "jwks",
    "verify",
  ]),
  reason: NonEmptyString,
  status: Schema.optionalKey(Schema.Number),
  errorCode: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return `OIDC ${this.operation} failed: ${this.reason}`;
  }
}

const isOidcError = Schema.is(OidcError);

export function normalizeOidcIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/gu, "");
}

export function oidcDiscoveryUrl(issuer: string): string {
  return `${normalizeOidcIssuer(issuer)}/.well-known/openid-configuration`;
}

export function generatePkceVerifier(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Base64Url.encode(bytes);
}

export function createPkceChallenge(verifier: string): string {
  const digest = sha256(new TextEncoder().encode(verifier));
  return Base64Url.encode(digest);
}

export function generateOAuthState(byteLength = 24): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Base64Url.encode(bytes);
}

export function buildOidcAuthorizeUrl(input: {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope?: string | ReadonlyArray<string> | undefined;
  readonly state: string;
  readonly codeChallenge: string;
  readonly nonce?: string | undefined;
  readonly extraParams?: Readonly<Record<string, string>> | undefined;
}): string {
  const url = new URL(input.authorizationEndpoint);
  const scopeValue =
    input.scope === undefined
      ? DEFAULT_OIDC_SCOPES.join(" ")
      : typeof input.scope === "string"
        ? input.scope
        : input.scope.join(" ");

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", scopeValue);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  if (input.nonce !== undefined && input.nonce.length > 0) {
    url.searchParams.set("nonce", input.nonce);
  }
  if (input.extraParams !== undefined) {
    for (const [key, value] of Object.entries(input.extraParams)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

const decodeDiscovery = Schema.decodeUnknownSync(OidcDiscoveryDocument);
const decodeTokenResponse = Schema.decodeUnknownSync(OidcTokenResponse);
const decodeDeviceAuthorization = Schema.decodeUnknownSync(OidcDeviceAuthorizationResponse);
const decodeKeySet = Schema.decodeUnknownEffect(Jwks.KeySet);

const OAuthErrorPayload = Schema.Struct({
  error: Schema.optionalKey(Schema.String),
  error_description: Schema.optionalKey(Schema.String),
});
const decodeOAuthErrorPayload = Schema.decodeUnknownOption(OAuthErrorPayload);

async function parseJsonResponse(
  response: Response,
  operation: OidcError["operation"],
): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    let errorCode: string | undefined;
    let description: string | undefined;
    try {
      const parsed = JSON.parse(text) as unknown;
      const decoded = decodeOAuthErrorPayload(parsed);
      if (decoded._tag === "Some") {
        errorCode = decoded.value.error;
        description = decoded.value.error_description;
      }
    } catch {
      // Fall back to HTTP status message below.
    }
    throw new OidcError({
      operation,
      reason: description ?? errorCode ?? `HTTP ${response.status}`,
      status: response.status,
      ...(errorCode !== undefined ? { errorCode } : {}),
    });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new OidcError({
      operation,
      reason: "Response was not valid JSON",
      status: response.status,
      cause,
    });
  }
}

export async function fetchOidcDiscovery(
  issuer: string,
  options?: {
    readonly fetch?: typeof globalThis.fetch | undefined;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<OidcDiscoveryDocument> {
  const fetchFn = options?.fetch ?? globalThis.fetch;
  const normalized = normalizeOidcIssuer(issuer);
  const url = oidcDiscoveryUrl(normalized);

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      headers: { accept: "application/json" },
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    throw new OidcError({
      operation: "discovery",
      reason: `Failed to fetch ${url}`,
      cause,
    });
  }

  const json = await parseJsonResponse(response, "discovery");
  let doc: OidcDiscoveryDocument;
  try {
    doc = decodeDiscovery(json);
  } catch (cause) {
    throw new OidcError({
      operation: "discovery",
      reason: "Invalid OpenID Connect discovery document",
      cause,
    });
  }

  if (normalizeOidcIssuer(doc.issuer) !== normalized) {
    throw new OidcError({
      operation: "discovery",
      reason: `Discovery issuer "${doc.issuer}" did not match expected "${normalized}"`,
    });
  }

  return doc;
}

export async function exchangeOidcAuthorizationCode(input: {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<OidcTokenResponse> {
  const fetchFn = input.fetch ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  if (input.clientSecret !== undefined && input.clientSecret.length > 0) {
    body.set("client_secret", input.clientSecret);
  }

  let response: Response;
  try {
    response = await fetchFn(input.tokenEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch (cause) {
    throw new OidcError({
      operation: "token_exchange",
      reason: "Authorization code exchange request failed",
      cause,
    });
  }

  const json = await parseJsonResponse(response, "token_exchange");
  try {
    return decodeTokenResponse(json);
  } catch (cause) {
    throw new OidcError({
      operation: "token_exchange",
      reason: "Invalid OIDC token response payload",
      cause,
    });
  }
}

export async function refreshOidcToken(input: {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly refreshToken: string;
  readonly scope?: string | ReadonlyArray<string> | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<OidcTokenResponse> {
  const fetchFn = input.fetch ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: input.clientId,
    refresh_token: input.refreshToken,
  });
  if (input.clientSecret !== undefined && input.clientSecret.length > 0) {
    body.set("client_secret", input.clientSecret);
  }
  if (input.scope !== undefined) {
    body.set("scope", typeof input.scope === "string" ? input.scope : input.scope.join(" "));
  }

  let response: Response;
  try {
    response = await fetchFn(input.tokenEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch (cause) {
    throw new OidcError({
      operation: "token_refresh",
      reason: "Refresh token request failed",
      cause,
    });
  }

  const json = await parseJsonResponse(response, "token_refresh");
  try {
    return decodeTokenResponse(json);
  } catch (cause) {
    throw new OidcError({
      operation: "token_refresh",
      reason: "Invalid OIDC refresh token response payload",
      cause,
    });
  }
}

export async function startOidcDeviceAuthorization(input: {
  readonly deviceAuthorizationEndpoint: string;
  readonly clientId: string;
  readonly scope?: string | ReadonlyArray<string> | undefined;
  readonly audience?: string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<OidcDeviceAuthorizationResponse> {
  const fetchFn = input.fetch ?? globalThis.fetch;
  const scopeValue =
    input.scope === undefined
      ? DEFAULT_OIDC_SCOPES.join(" ")
      : typeof input.scope === "string"
        ? input.scope
        : input.scope.join(" ");
  const body = new URLSearchParams({
    client_id: input.clientId,
    scope: scopeValue,
  });
  if (input.audience !== undefined && input.audience.length > 0) {
    body.set("audience", input.audience);
  }

  let response: Response;
  try {
    response = await fetchFn(input.deviceAuthorizationEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch (cause) {
    throw new OidcError({
      operation: "device_authorization",
      reason: "Device authorization request failed",
      cause,
    });
  }

  const json = await parseJsonResponse(response, "device_authorization");
  try {
    return decodeDeviceAuthorization(json);
  } catch (cause) {
    throw new OidcError({
      operation: "device_authorization",
      reason: "Invalid device authorization response",
      cause,
    });
  }
}

export type OidcDevicePollResult =
  | { readonly status: "approved"; readonly tokens: OidcTokenResponse }
  | { readonly status: "pending" }
  | { readonly status: "slow_down" }
  | { readonly status: "denied" | "expired"; readonly error: string };

export async function pollOidcDeviceTokenOnce(input: {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly deviceCode: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<OidcDevicePollResult> {
  const fetchFn = input.fetch ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: input.clientId,
    device_code: input.deviceCode,
  });

  let response: Response;
  try {
    response = await fetchFn(input.tokenEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch (cause) {
    throw new OidcError({
      operation: "device_token",
      reason: "Device token poll request failed",
      cause,
    });
  }

  if (response.ok) {
    const json = await parseJsonResponse(response, "device_token");
    try {
      return { status: "approved", tokens: decodeTokenResponse(json) };
    } catch (cause) {
      throw new OidcError({
        operation: "device_token",
        reason: "Invalid device token response payload",
        cause,
      });
    }
  }

  const text = await response.text();
  let errorCode: string | undefined;
  let description: string | undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    const decoded = decodeOAuthErrorPayload(parsed);
    if (decoded._tag === "Some") {
      errorCode = decoded.value.error;
      description = decoded.value.error_description;
    }
  } catch {
    // Non-JSON error response handled below.
  }

  if (errorCode === "authorization_pending") {
    return { status: "pending" };
  }
  if (errorCode === "slow_down") {
    return { status: "slow_down" };
  }
  if (errorCode === "access_denied") {
    return { status: "denied", error: description ?? errorCode };
  }
  if (errorCode === "expired_token") {
    return { status: "expired", error: description ?? errorCode };
  }

  throw new OidcError({
    operation: "device_token",
    reason: description ?? errorCode ?? `HTTP ${response.status}`,
    status: response.status,
    ...(errorCode !== undefined ? { errorCode } : {}),
  });
}

const OidcTokenClaimsSchema = Schema.StructWithRest(
  Schema.Struct({
    sub: NonEmptyString,
    iss: NonEmptyString,
    email: Schema.optionalKey(Schema.String),
    email_verified: Schema.optionalKey(Schema.Boolean),
    name: Schema.optionalKey(Schema.String),
    preferred_username: Schema.optionalKey(Schema.String),
    picture: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

const signatureLayer = Signature.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto));

export interface OidcJwtVerifierOptions {
  readonly issuer: string;
  readonly jwksUri?: string | undefined;
  readonly audience?: string | ReadonlyArray<string> | undefined;
  readonly allowedAlgorithms?: ReadonlyArray<Jwk.AsymmetricAlgorithm> | undefined;
  readonly cacheTtlMs?: number | undefined;
  readonly refreshCooldownMs?: number | undefined;
  readonly clockToleranceSeconds?: number | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export interface OidcJwtVerifier {
  readonly verify: (token: string) => Effect.Effect<OidcVerifiedPrincipal, OidcError>;
  readonly clearCache: () => void;
}

export function createOidcJwtVerifier(options: OidcJwtVerifierOptions): OidcJwtVerifier {
  const expectedIssuer = normalizeOidcIssuer(options.issuer);
  const algorithms =
    options.allowedAlgorithms && options.allowedAlgorithms.length > 0
      ? options.allowedAlgorithms
      : DEFAULT_OIDC_ALLOWED_ALGORITHMS;
  const cacheTtlMs = options.cacheTtlMs ?? 10 * 60_000;
  const refreshCooldownMs = options.refreshCooldownMs ?? 30_000;
  const clockToleranceSeconds = options.clockToleranceSeconds ?? 60;
  const fetchFn = options.fetch ?? globalThis.fetch;

  let resolvedJwksUri: string | undefined = options.jwksUri;
  let cached:
    | {
        readonly service: Jwks.Jwks["Service"];
        readonly fetchedAt: number;
        readonly expiresAt: number;
      }
    | undefined;

  const semaphore = Semaphore.makeUnsafe(1);

  const loadJwksSnapshot = Effect.fn("oidc.loadJwks")(function* (forceRefresh: boolean) {
    const now = yield* Clock.currentTimeMillis;
    if (!forceRefresh && cached !== undefined && now < cached.expiresAt) {
      return cached;
    }

    if (forceRefresh && cached !== undefined && now - cached.fetchedAt < refreshCooldownMs) {
      return cached;
    }

    if (resolvedJwksUri === undefined) {
      const discovery = yield* Effect.tryPromise({
        try: () => fetchOidcDiscovery(expectedIssuer, { fetch: fetchFn }),
        catch: (error) =>
          isOidcError(error)
            ? error
            : new OidcError({
                operation: "discovery",
                reason: "Failed to resolve OIDC discovery document for JWKS",
                cause: error,
              }),
      });
      resolvedJwksUri = discovery.jwks_uri;
    }

    const jwksUri = resolvedJwksUri;
    const rawKeySet = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetchFn(jwksUri, {
          method: "GET",
          headers: { accept: "application/json" },
        });
        return parseJsonResponse(response, "jwks");
      },
      catch: (error) =>
        isOidcError(error)
          ? error
          : new OidcError({
              operation: "jwks",
              reason: `Failed to fetch JWKS from ${jwksUri}`,
              cause: error,
            }),
    });

    const keySet = yield* decodeKeySet(rawKeySet).pipe(
      Effect.mapError(
        (cause) =>
          new OidcError({
            operation: "jwks",
            reason: "JWKS payload is invalid",
            cause,
          }),
      ),
    );
    const service = yield* Jwks.makeLocal(keySet);
    const snapshot = {
      service,
      fetchedAt: yield* Clock.currentTimeMillis,
      expiresAt: (yield* Clock.currentTimeMillis) + cacheTtlMs,
    };
    cached = snapshot;
    return snapshot;
  });

  const jwksService = Jwks.Jwks.of({
    resolve: Effect.fn("oidc.jwks.resolve")(
      function* (selection) {
        const snapshot = yield* semaphore.withPermits(1)(loadJwksSnapshot(false));
        const resolved = yield* snapshot.service.resolve(selection).pipe(Effect.result);
        if (resolved._tag === "Success") {
          return resolved.success;
        }
        const error = resolved.failure;
        if (JoseError.isJoseError(error) && error.reason._tag === "KeyNotFound") {
          const refreshed = yield* semaphore.withPermits(1)(loadJwksSnapshot(true));
          return yield* refreshed.service.resolve(selection);
        }
        return yield* error;
      },
      Effect.catchTags({
        OidcError: (err) =>
          Effect.fail(
            new JoseError.JoseError({
              reason: new JoseError.KeySetUnavailable({
                description: err.message,
                cause: err,
              }),
            }),
          ),
      }),
    ),
  });

  const jwksLayer = Layer.succeed(Jwks.Jwks, jwksService);
  const verificationLayer = Layer.merge(signatureLayer, jwksLayer);

  const verify = Effect.fn("oidc.verify")(function* (
    token: string,
  ): Effect.fn.Return<OidcVerifiedPrincipal, OidcError> {
    const acceptedIssuers = expectedIssuer.endsWith("/")
      ? [expectedIssuer, expectedIssuer.slice(0, -1)]
      : [expectedIssuer, `${expectedIssuer}/`];

    const verified = yield* Jwt.verifyWithKeySet(OidcTokenClaimsSchema, token, {
      issuer: acceptedIssuers,
      ...(options.audience !== undefined ? { audience: options.audience } : {}),
      algorithms,
      clockTolerance: `${clockToleranceSeconds} seconds`,
      requiredClaims: ["sub", "iss"],
    }).pipe(
      Effect.provide(verificationLayer),
      Effect.mapError((cause) => {
        if (JoseError.isJoseError(cause) && cause.reason._tag === "KeySetUnavailable") {
          const inner = cause.reason.cause;
          if (isOidcError(inner)) {
            return inner;
          }
        }
        return new OidcError({
          operation: "verify",
          reason: cause instanceof Error ? cause.message : String(cause),
          cause,
        });
      }),
    );

    const { claims } = verified;
    return {
      subject: claims.sub,
      issuer: normalizeOidcIssuer(claims.iss),
      ...(claims.email !== undefined ? { email: claims.email } : {}),
      ...(claims.email_verified !== undefined ? { emailVerified: claims.email_verified } : {}),
      ...(claims.name !== undefined ? { name: claims.name } : {}),
      ...(claims.preferred_username !== undefined
        ? { preferredUsername: claims.preferred_username }
        : {}),
      ...(claims.picture !== undefined ? { picture: claims.picture } : {}),
      claims: claims as Readonly<Record<string, Schema.Json>>,
    };
  });

  return {
    verify,
    clearCache: () => {
      cached = undefined;
      if (options.jwksUri === undefined) {
        resolvedJwksUri = undefined;
      }
    },
  };
}
