import { createOidcJwtVerifier, OidcError, type OidcVerifiedPrincipal } from "@t3tools/shared/oidc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayConfiguration from "../Config.ts";

export class OidcAuth extends Context.Service<
  OidcAuth,
  {
    readonly verifyBearerToken: (token: string) => Effect.Effect<OidcVerifiedPrincipal, OidcError>;
  }
>()("t3code-relay/auth/OidcAuth") {}

export const layer = Layer.effect(
  OidcAuth,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const oidc = config.oidc;
    const verifier =
      oidc === null
        ? null
        : createOidcJwtVerifier({
            issuer: oidc.issuer,
            ...(oidc.jwksUri !== undefined ? { jwksUri: oidc.jwksUri } : {}),
            ...(oidc.audience !== undefined ? { audience: oidc.audience } : {}),
          });

    return OidcAuth.of({
      verifyBearerToken: Effect.fn("relay.auth.oidc.verify")(function* (token) {
        if (verifier === null) {
          return yield* new OidcError({
            operation: "verify",
            reason: "OIDC authentication is not configured",
          });
        }
        return yield* verifier.verify(token);
      }),
    });
  }),
);

export const layerTest = (
  verifyBearerToken: (token: string) => Effect.Effect<OidcVerifiedPrincipal, OidcError>,
) =>
  Layer.succeed(
    OidcAuth,
    OidcAuth.of({
      verifyBearerToken,
    }),
  );
