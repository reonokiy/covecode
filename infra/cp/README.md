# cove-cp

`cove-cp` is a standalone, self-hosted **Node.js + PostgreSQL** control plane and `libp2p` tunnel gateway for connecting remote Cove Code environments and mobile/web/desktop clients without Clerk or Cloudflare dependencies.

## Features

- **Standard OIDC authentication**: Verifies user Bearer JWTs against any OpenID Connect provider via `.well-known/openid-configuration` discovery and JWKS (Keycloak, Authentik, Authelia, Dex, ZITADEL, Auth0, Okta, Google, etc.), and advertises OIDC configuration at `GET /.well-known/cove-control-plane`.
- **PostgreSQL storage**: Persists environment links, DPoP replay nonces, managed tunnel allocations, mobile devices, and agent activity state using Drizzle ORM (`infra/cp/migrations/postgres/`).
- **libp2p v3 tunnel & P2P gateway**: Hosts an in-process `js-libp2p` relay + circuit-relay + HTTP/WS stream bridge (`@t3tools/libp2p-tunnel`) replacing legacy tunnel daemons. Traffic reaches environments via `/t/<endpointKey>/...` on a single host/IP or optional wildcard subdomains (`COVE_CP_TUNNEL_BASE_DOMAIN`).
- **Offline webhook inbox & optional push notifications**: In-process webhook buffering while environments reconnect, plus optional APNs and FCM workers when configured.
- **No third-party telemetry**: Mobile telemetry ingestion is disabled by default.

## Code Map

- [`src/bin.ts`](./src/bin.ts): CLI entrypoint that parses environment variables, runs PostgreSQL migrations, and manages server lifecycle.
- [`src/server.ts`](./src/server.ts): Wires Node HTTP/WS server, `Libp2pTunnelRegistry`, Effect services, periodic cleanup fibers, and `HttpRouter.toWebHandler`.
- [`src/http/Api.ts`](./src/http/Api.ts): Control-plane HTTP API handlers and authentication middleware (`OidcAuth`, DPoP, environment credentials).
- [`src/auth/OidcAuth.ts`](./src/auth/OidcAuth.ts): OIDC Discovery + JWKS bearer token verification.
- [`src/environments`](./src/environments): Environment linking, credentials, `Libp2pTunnelRegistry`, `ManagedEndpointProvider`, and connector flows.
- [`src/persistence/schema.ts`](./src/persistence/schema.ts): PostgreSQL Drizzle schema and [`migrations/postgres`](./migrations/postgres) SQL migrations.
- [`Dockerfile`](./Dockerfile) & [`docker-compose.example.yml`](./docker-compose.example.yml): Container deployment templates.

## Running Locally

Install dependencies from the repository root, start PostgreSQL, configure `.env` from [`.env.example`](./.env.example), and start the server:

```sh
vp i
cp infra/cp/.env.example infra/cp/.env
# Edit infra/cp/.env for your database, writable data directory and OIDC provider.
vp run --filter cove-cp start
```

Wait for `cove-cp listening` and verify the public control-plane metadata endpoint:

```sh
curl -s http://127.0.0.1:8787/.well-known/cove-control-plane | jq
```

## Running Tests & Typecheck

```sh
vp test run infra/cp/src
vp run --filter cove-cp typecheck
```

## Docker Compose Deployment

Copy [`docker-compose.example.yml`](./docker-compose.example.yml) and adjust `COVE_CP_PUBLIC_URL`, `COVE_CP_OIDC_ISSUER`, `COVE_CP_OIDC_CLIENT_ID`, and `COVE_CP_LIBP2P_ANNOUNCE`:

```sh
docker compose --env-file infra/cp/.env -f infra/cp/docker-compose.example.yml up --build
```
