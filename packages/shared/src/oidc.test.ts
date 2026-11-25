import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Jwk from "effect/jose/Jwk";
import * as Jwt from "effect/jose/Jwt";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  buildOidcAuthorizeUrl,
  createOidcJwtVerifier,
  createPkceChallenge,
  exchangeOidcAuthorizationCode,
  fetchOidcDiscovery,
  OidcError,
  oidcDiscoveryUrl,
  pollOidcDeviceTokenOnce,
  refreshOidcToken,
  startOidcDeviceAuthorization,
} from "./oidc.ts";

const cryptoLayer = Signature.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto));

const TestClaimsSchema = Schema.Struct({
  sub: Schema.String,
  iss: Schema.String,
  aud: Schema.optionalKey(Schema.String),
  exp: Schema.optionalKey(Schema.Finite),
  iat: Schema.optionalKey(Schema.Finite),
  email: Schema.optionalKey(Schema.String),
  email_verified: Schema.optionalKey(Schema.Boolean),
  name: Schema.optionalKey(Schema.String),
  preferred_username: Schema.optionalKey(Schema.String),
});

describe("oidc", () => {
  it("computes RFC 7636 Appendix B S256 PKCE challenges and authorize URLs", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(createPkceChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");

    const url = new URL(
      buildOidcAuthorizeUrl({
        authorizationEndpoint: "https://auth.example.com/oauth2/authorize",
        clientId: "cove-cli",
        redirectUri: "http://127.0.0.1:41234/callback",
        scope: ["openid", "profile", "email"],
        state: "state-123",
        codeChallenge: createPkceChallenge(verifier),
        nonce: "nonce-456",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://auth.example.com/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cove-cli");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:41234/callback");
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("code_challenge")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBe("nonce-456");
    expect(oidcDiscoveryUrl("https://auth.example.com/realms/cove/")).toBe(
      "https://auth.example.com/realms/cove/.well-known/openid-configuration",
    );
  });

  it("fetches OIDC discovery and rejects issuer mismatches", async () => {
    const validFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          issuer: "https://auth.example.com/realms/cove/",
          authorization_endpoint:
            "https://auth.example.com/realms/cove/protocol/openid-connect/auth",
          token_endpoint: "https://auth.example.com/realms/cove/protocol/openid-connect/token",
          jwks_uri: "https://auth.example.com/realms/cove/protocol/openid-connect/certs",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const doc = await fetchOidcDiscovery("https://auth.example.com/realms/cove", {
      fetch: validFetch,
    });
    expect(doc.jwks_uri).toBe("https://auth.example.com/realms/cove/protocol/openid-connect/certs");

    const mismatchedFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          issuer: "https://evil.example.com",
          authorization_endpoint: "https://evil.example.com/auth",
          token_endpoint: "https://evil.example.com/token",
          jwks_uri: "https://evil.example.com/jwks",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    await expect(
      fetchOidcDiscovery("https://auth.example.com/realms/cove", { fetch: mismatchedFetch }),
    ).rejects.toBeInstanceOf(OidcError);
  });

  it("handles authorization code exchange, refresh, and device authorization polling", async () => {
    let pollStep = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const params = new URLSearchParams(bodyText);

      if (url.endsWith("/device")) {
        expect(params.get("client_id")).toBe("cove-cli");
        return new Response(
          JSON.stringify({
            device_code: "dev-code-1",
            user_code: "ABCD-EFGH",
            verification_uri: "https://auth.example.com/device",
            verification_uri_complete: "https://auth.example.com/device?user_code=ABCD-EFGH",
            expires_in: 600,
            interval: 5,
          }),
          { status: 200 },
        );
      }

      const grantType = params.get("grant_type");
      if (grantType === "authorization_code") {
        expect(params.get("code")).toBe("auth-code-1");
        expect(params.get("code_verifier")).toBe("verifier-1");
        return new Response(
          JSON.stringify({
            access_token: "access-1",
            id_token: "id-1",
            refresh_token: "refresh-1",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }

      if (grantType === "refresh_token") {
        expect(params.get("refresh_token")).toBe("refresh-1");
        return new Response(
          JSON.stringify({
            access_token: "access-2",
            refresh_token: "refresh-2",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }

      if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
        pollStep += 1;
        if (pollStep === 1) {
          return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
        }
        if (pollStep === 2) {
          return new Response(JSON.stringify({ error: "slow_down" }), { status: 400 });
        }
        if (pollStep === 3) {
          return new Response(
            JSON.stringify({
              access_token: "device-access-1",
              id_token: "device-id-1",
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "access_denied" }), { status: 403 });
      }

      return new Response("unexpected", { status: 500 });
    };

    const exchanged = await exchangeOidcAuthorizationCode({
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "cove-cli",
      code: "auth-code-1",
      redirectUri: "http://127.0.0.1:41234/callback",
      codeVerifier: "verifier-1",
      fetch: mockFetch,
    });
    expect(exchanged.access_token).toBe("access-1");
    expect(exchanged.refresh_token).toBe("refresh-1");

    const refreshed = await refreshOidcToken({
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "cove-cli",
      refreshToken: "refresh-1",
      fetch: mockFetch,
    });
    expect(refreshed.access_token).toBe("access-2");

    const device = await startOidcDeviceAuthorization({
      deviceAuthorizationEndpoint: "https://auth.example.com/device",
      clientId: "cove-cli",
      fetch: mockFetch,
    });
    expect(device.user_code).toBe("ABCD-EFGH");

    expect(
      await pollOidcDeviceTokenOnce({
        tokenEndpoint: "https://auth.example.com/token",
        clientId: "cove-cli",
        deviceCode: device.device_code,
        fetch: mockFetch,
      }),
    ).toEqual({ status: "pending" });

    expect(
      await pollOidcDeviceTokenOnce({
        tokenEndpoint: "https://auth.example.com/token",
        clientId: "cove-cli",
        deviceCode: device.device_code,
        fetch: mockFetch,
      }),
    ).toEqual({ status: "slow_down" });

    expect(
      await pollOidcDeviceTokenOnce({
        tokenEndpoint: "https://auth.example.com/token",
        clientId: "cove-cli",
        deviceCode: device.device_code,
        fetch: mockFetch,
      }),
    ).toEqual({
      status: "approved",
      tokens: { access_token: "device-access-1", id_token: "device-id-1" },
    });

    expect(
      await pollOidcDeviceTokenOnce({
        tokenEndpoint: "https://auth.example.com/token",
        clientId: "cove-cli",
        deviceCode: device.device_code,
        fetch: mockFetch,
      }),
    ).toEqual({ status: "denied", error: "access_denied" });
  });

  it.effect("verifies OIDC JWTs via JWKS, enforces claims, and handles key rotation", () =>
    Effect.gen(function* () {
      const key1 = yield* Jwk.generateKeyPair({ algorithm: "ES256", kid: "key-1" });
      const key2 = yield* Jwk.generateKeyPair({ algorithm: "RS256", kid: "key-2" });
      const signingKey1 = yield* Jwk.importPrivate(key1.privateKey, "ES256");
      const signingKey2 = yield* Jwk.importPrivate(key2.privateKey, "RS256");

      let activeKeys = [key1.publicKey];
      let jwksFetches = 0;

      const mockFetch: typeof fetch = async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "http://127.0.0.1:9000/cove/.well-known/openid-configuration") {
          return new Response(
            JSON.stringify({
              issuer: "http://127.0.0.1:9000/cove",
              authorization_endpoint: "http://127.0.0.1:9000/cove/auth",
              token_endpoint: "http://127.0.0.1:9000/cove/token",
              jwks_uri: "http://127.0.0.1:9000/cove/jwks.json",
            }),
            { status: 200 },
          );
        }
        if (url === "http://127.0.0.1:9000/cove/jwks.json") {
          jwksFetches += 1;
          return new Response(JSON.stringify({ keys: activeKeys }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      };

      const verifier = createOidcJwtVerifier({
        issuer: "http://127.0.0.1:9000/cove",
        audience: "cove-control-plane",
        refreshCooldownMs: 30_000,
        cacheTtlMs: 600_000,
        fetch: mockFetch,
      });

      const validToken = Redacted.value(
        yield* Jwt.sign(
          TestClaimsSchema,
          {
            sub: "user-abc",
            iss: "http://127.0.0.1:9000/cove",
            aud: "cove-control-plane",
            exp: 120,
            iat: 0,
            email: "dev@example.com",
            email_verified: true,
            name: "Developer",
          },
          signingKey1,
        ),
      );

      const principal = yield* verifier.verify(validToken);
      expect(principal.subject).toBe("user-abc");
      expect(principal.issuer).toBe("http://127.0.0.1:9000/cove");
      expect(principal.email).toBe("dev@example.com");
      expect(principal.emailVerified).toBe(true);
      expect(principal.name).toBe("Developer");
      expect(jwksFetches).toBe(1);

      const wrongIssuerToken = Redacted.value(
        yield* Jwt.sign(
          TestClaimsSchema,
          {
            sub: "user-abc",
            iss: "http://attacker.example.com",
            aud: "cove-control-plane",
            exp: 120,
          },
          signingKey1,
        ),
      );
      const wrongIssuerExit = yield* verifier.verify(wrongIssuerToken).pipe(Effect.exit);
      expect(wrongIssuerExit._tag).toBe("Failure");

      const wrongAudToken = Redacted.value(
        yield* Jwt.sign(
          TestClaimsSchema,
          {
            sub: "user-abc",
            iss: "http://127.0.0.1:9000/cove",
            aud: "other-service",
            exp: 120,
          },
          signingKey1,
        ),
      );
      const wrongAudExit = yield* verifier.verify(wrongAudToken).pipe(Effect.exit);
      expect(wrongAudExit._tag).toBe("Failure");

      // Advance past clockTolerance + token exp so the first token expires and rotation cooldown passes.
      yield* TestClock.adjust("4 minutes");
      const expiredExit = yield* verifier.verify(validToken).pipe(Effect.exit);
      expect(expiredExit._tag).toBe("Failure");

      // Rotate JWKS to key-2 and sign with key-2.
      activeKeys = [key1.publicKey, key2.publicKey];
      const rotatedToken = Redacted.value(
        yield* Jwt.sign(
          TestClaimsSchema,
          {
            sub: "user-rotated",
            iss: "http://127.0.0.1:9000/cove/",
            aud: "cove-control-plane",
            exp: 600,
            preferred_username: "rotated",
          },
          signingKey2,
        ),
      );

      const rotatedPrincipal = yield* verifier.verify(rotatedToken);
      expect(rotatedPrincipal.subject).toBe("user-rotated");
      expect(rotatedPrincipal.preferredUsername).toBe("rotated");
      expect(jwksFetches).toBe(2);
    }).pipe(Effect.provide(cryptoLayer)),
  );
});
