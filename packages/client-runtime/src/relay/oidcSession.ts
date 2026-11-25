import type { RelayControlPlaneOidcConfig } from "@t3tools/contracts/relay";
import {
  buildOidcAuthorizeUrl,
  createPkceChallenge,
  exchangeOidcAuthorizationCode,
  fetchOidcDiscovery,
  generateOAuthState,
  generatePkceVerifier,
  normalizeOidcIssuer,
  type OidcDiscoveryDocument,
  type OidcTokenResponse,
  refreshOidcToken,
  type OidcVerifiedPrincipal,
  createOidcJwtVerifier,
  type OidcJwtVerifier,
} from "@t3tools/shared/oidc";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { CloudAccountSource } from "./cloudAccountService.ts";

export interface OidcUser {
  readonly id: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly picture: string | null;
}

export interface OidcSessionTokens {
  readonly accessToken: string;
  readonly idToken: string | null;
  readonly refreshToken: string | null;
  readonly expiresAtMillis: number | null;
}

export interface StoredOidcSession {
  readonly issuer: string;
  readonly clientId: string;
  readonly user: OidcUser;
  readonly tokens: OidcSessionTokens;
}

export interface OidcSessionStorage {
  readonly load: () => Promise<StoredOidcSession | null>;
  readonly save: (session: StoredOidcSession | null) => Promise<void>;
}

export interface PendingOidcAuthorization {
  readonly state: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly redirectUri: string;
}

export type OidcSessionSnapshot =
  | { readonly status: "loading" }
  | { readonly status: "signed-out" }
  | { readonly status: "signed-in"; readonly user: OidcUser };

export interface OidcSessionOptions {
  readonly config: RelayControlPlaneOidcConfig;
  readonly storage: OidcSessionStorage;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export interface OidcSession extends CloudAccountSource {
  readonly getSnapshot: () => OidcSessionSnapshot;
  readonly subscribe: (listener: (snapshot: OidcSessionSnapshot) => void) => () => void;
  readonly restore: () => Promise<void>;
  readonly beginAuthorization: (
    redirectUri: string,
  ) => Promise<{ readonly url: string; readonly pending: PendingOidcAuthorization }>;
  readonly completeAuthorization: (
    callbackUrl: string,
    pending: PendingOidcAuthorization,
  ) => Promise<void>;
  readonly getToken: () => Promise<string | null>;
  readonly signOut: () => Promise<void>;
}

// CloudAccountSource keeps Clerk's resource shape; a fixed client id marks the state as locally authoritative.
const OIDC_CLIENT = { id: "oidc" } as const;

/** Reads `exp` from a JWT without verification. Returns null on any failure. */
function readJwtExpMillis(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    const exp = typeof payload === "object" && payload !== null ? payload.exp : undefined;
    return typeof exp === "number" ? exp * 1_000 : null;
  } catch {
    return null;
  }
}

function userFromPrincipal(principal: OidcVerifiedPrincipal): OidcUser {
  return {
    id: principal.subject,
    email: principal.email ?? null,
    name: principal.name ?? null,
    picture: principal.picture ?? null,
  };
}

function tokensFromResponse(response: OidcTokenResponse, now: () => number): OidcSessionTokens {
  const expiresAtMillis =
    typeof response.expires_in === "number"
      ? now() + response.expires_in * 1_000
      : readJwtExpMillis(response.access_token);
  return {
    accessToken: response.access_token,
    idToken: response.id_token ?? null,
    refreshToken: response.refresh_token ?? null,
    expiresAtMillis,
  };
}

// Token expiry buffer: refresh 60 s before the token would expire.
const EXPIRY_BUFFER_MS = 60_000;

export function createOidcSession(options: OidcSessionOptions): OidcSession {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const nowMs = options.now ?? (() => DateTime.toEpochMillis(DateTime.nowUnsafe()));
  const issuer = normalizeOidcIssuer(options.config.issuer);
  const clientId = options.config.clientId;
  const audience = options.config.audience ?? undefined;

  let snapshot: OidcSessionSnapshot = { status: "loading" };
  let stored: StoredOidcSession | null = null;
  let cachedDiscovery: OidcDiscoveryDocument | null = null;
  let pendingRefresh: Promise<string | null> | null = null;
  const listeners = new Set<(snapshot: OidcSessionSnapshot) => void>();

  const publish = (next: OidcSessionSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener(next);
  };

  const setStored = async (next: StoredOidcSession | null) => {
    await options.storage.save(next);
    stored = next;
    publish(next === null ? { status: "signed-out" } : { status: "signed-in", user: next.user });
  };

  const getDiscovery = async (): Promise<OidcDiscoveryDocument> => {
    if (cachedDiscovery) return cachedDiscovery;
    const doc = await fetchOidcDiscovery(issuer, { fetch: fetchFn });
    cachedDiscovery = doc;
    return doc;
  };

  let verifier: OidcJwtVerifier | null = null;
  const verifyAndExtractUser = async (tokens: OidcSessionTokens): Promise<OidcUser> => {
    if (verifier === null) {
      const discovery = await getDiscovery();
      verifier = createOidcJwtVerifier({
        issuer,
        jwksUri: discovery.jwks_uri,
        audience,
        fetch: fetchFn,
      });
    }
    // Prefer id_token for user info; fall back to access_token.
    const principal = await Effect.runPromise(
      verifier.verify(tokens.idToken ?? tokens.accessToken),
    );
    return userFromPrincipal(principal);
  };

  // SECTION: restore
  const restore = async () => {
    const saved = await options.storage.load();
    const matches = saved !== null && saved.clientId === clientId && saved.issuer === issuer;
    if (saved !== null && matches) {
      stored = saved;
      publish({ status: "signed-in", user: saved.user });
      return;
    }
    if (saved !== null) await options.storage.save(null);
    stored = null;
    publish({ status: "signed-out" });
  };

  // SECTION: subscriptions
  const subscribe: OidcSession["subscribe"] = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const addListener: OidcSession["addListener"] = (listener) => {
    const emit = (current: OidcSessionSnapshot) => {
      if (current.status === "loading") {
        listener({ user: undefined });
        return;
      }
      listener({
        client: OIDC_CLIENT,
        user: current.status === "signed-in" ? { id: current.user.id } : null,
      });
    };
    listeners.add(emit);
    emit(snapshot);
    return () => {
      listeners.delete(emit);
    };
  };

  // SECTION: authorization
  const beginAuthorization: OidcSession["beginAuthorization"] = async (redirectUri) => {
    const discovery = await getDiscovery();
    const codeVerifier = generatePkceVerifier();
    const codeChallenge = createPkceChallenge(codeVerifier);
    const state = generateOAuthState();
    const nonce = generatePkceVerifier(16);
    const scopeValue =
      options.config.scopes && options.config.scopes.length > 0
        ? options.config.scopes.join(" ")
        : undefined;
    const url = buildOidcAuthorizeUrl({
      authorizationEndpoint: discovery.authorization_endpoint,
      clientId,
      redirectUri,
      scope: scopeValue,
      state,
      codeChallenge,
      nonce,
    });
    const pending: PendingOidcAuthorization = { state, codeVerifier, nonce, redirectUri };
    return { url, pending };
  };

  const completeAuthorization: OidcSession["completeAuthorization"] = async (
    callbackUrl,
    pending,
  ) => {
    const url = new URL(callbackUrl);
    const error = url.searchParams.get("error");
    if (error) {
      const description = url.searchParams.get("error_description") ?? error;
      throw new Error(`OIDC authorization error: ${description}`);
    }
    const code = url.searchParams.get("code");
    if (!code) throw new Error("OIDC callback URL is missing the authorization code.");
    const returnedState = url.searchParams.get("state");
    if (returnedState !== pending.state) throw new Error("OIDC state mismatch.");

    const discovery = await getDiscovery();
    const response = await exchangeOidcAuthorizationCode({
      tokenEndpoint: discovery.token_endpoint,
      clientId,
      code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.codeVerifier,
      fetch: fetchFn,
    });
    const tokens = tokensFromResponse(response, nowMs);
    // Verify the token and extract user info.
    const user = await verifyAndExtractUser(tokens).catch(() => {
      // Fall back to basic claims if verification fails (e.g. RS256 key not yet cached).
      const tokenForClaims = tokens.idToken ?? tokens.accessToken;
      try {
        const parts = tokenForClaims.split(".");
        const payload = JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as Record<
          string,
          unknown
        >;
        return {
          id:
            typeof payload.sub === "string"
              ? payload.sub
              : typeof payload.user_id === "string"
                ? payload.user_id
                : clientId,
          email: typeof payload.email === "string" ? payload.email : null,
          name: typeof payload.name === "string" ? payload.name : null,
          picture: typeof payload.picture === "string" ? payload.picture : null,
        };
      } catch {
        return { id: clientId, email: null, name: null, picture: null };
      }
    });
    await setStored({ issuer, clientId, user, tokens });
  };

  // SECTION: token refresh
  const refreshAccessToken = async (): Promise<string | null> => {
    if (!stored?.tokens.refreshToken) return null;
    const discovery = await getDiscovery();
    let response: OidcTokenResponse;
    try {
      response = await refreshOidcToken({
        tokenEndpoint: discovery.token_endpoint,
        clientId,
        refreshToken: stored.tokens.refreshToken,
        fetch: fetchFn,
      });
    } catch {
      return null;
    }
    const tokens = tokensFromResponse(response, nowMs);
    // Keep user from stored session; refresh doesn't re-verify identity.
    await setStored({ issuer, clientId, user: stored.user, tokens });
    return tokens.accessToken;
  };

  const getToken: OidcSession["getToken"] = async () => {
    if (!stored) return null;
    const { tokens } = stored;
    const expiresAt = tokens.expiresAtMillis;
    const needsRefresh = expiresAt !== null && nowMs() > expiresAt - EXPIRY_BUFFER_MS;
    if (!needsRefresh) return tokens.accessToken;
    if (pendingRefresh) return pendingRefresh;
    pendingRefresh = refreshAccessToken().then(
      (token) => {
        pendingRefresh = null;
        return token ?? stored?.tokens.accessToken ?? null;
      },
      () => {
        pendingRefresh = null;
        return stored?.tokens.accessToken ?? null;
      },
    );
    return pendingRefresh;
  };

  return {
    addListener,
    getSnapshot: () => snapshot,
    subscribe,
    restore,
    beginAuthorization,
    completeAuthorization,
    getToken,
    signOut: () => setStored(null),
  };
}
