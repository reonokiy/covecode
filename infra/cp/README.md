# cove-cp

`cove-cp` is a standalone, self-hosted **Node.js + PostgreSQL** control plane and `libp2p` tunnel gateway for connecting remote Cove Code environments and mobile/web/desktop clients without Clerk or Cloudflare dependencies.

## Features

- **Standard OIDC authentication**: Verifies user Bearer JWTs against any OpenID Connect provider via `.well-known/openid-configuration` discovery and JWKS (Keycloak, Authentik, Authelia, Dex, ZITADEL, Auth0, Okta, Google, etc.), and advertises OIDC configuration at `GET /.well-known/cove-control-plane`.
- **PostgreSQL storage**: Persists environment links, DPoP replay nonces, managed tunnel allocations, mobile devices, and agent activity state using Drizzle ORM (`infra/cp/migrations/postgres/`).
- **Encrypted environment connections.** Clients verify the environment peer ID and try a direct libp2p connection. Circuit Relay v2 carries the encrypted stream when direct connectivity fails. The CP handles discovery, authentication and reachability checks.
- **Third-party webhooks and rich notifications.** The CP accepts webhook bodies over HTTPS, buffers them while an environment is offline and forwards them to its hook handler. The CP and the configured push provider can read the fields used for lock-screen notifications and Live Activities.

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

For browser relay fallback, serve the web app over HTTPS and advertise a secure WebSocket relay, for example `/dns4/p2p.example.com/tcp/443/tls/ws`. Forward WebSocket upgrades at that hostname to the CP's WebSocket listener (port 4002 by default). Advertise the public TCP listener as well for native clients. The CP includes its peer ID in the discovery response. Keep its data directory on persistent storage.

Give users the HTTPS origin in `COVE_CP_PUBLIC_URL`. Clients fetch `/.well-known/cove-control-plane` there before sign-in. Register the web app’s origin with a trailing slash as an OIDC redirect URI, and `covecode://app/auth/cove` for the desktop app (`covecode-dev://app/auth/cove` for development). Register the mobile app’s Expo redirect URI for its installed variant as well.

Update the environment server with the CP so it registers before requesting a relay reservation. Each relayed connection is limited to one hour and 1 GiB by default. Set `COVE_CP_LIBP2P_RELAY_DURATION_MS` and `COVE_CP_LIBP2P_RELAY_BYTES` to adjust those limits.

On first connection, run `cove connect peer-id` on the environment machine and compare its output with the ID shown by the client. Each client remembers the verified ID.

## Deploying multiple replicas

Point one public HTTPS origin at all CP HTTP listeners. Configure the load balancer to check `GET /health`. The API can serve successive requests on different replicas. Give each relay a dedicated DNS name or port that always reaches that peer. For Web clients, terminate TLS for each relay hostname and forward WebSocket upgrades to that replica.

1. Point all replicas at the same PostgreSQL database. Use the same `COVE_CP_PUBLIC_URL`, OIDC settings, tunnel namespace, Ed25519 signing key pair (`COVE_CP_SIGNING_PRIVATE_KEY` and `COVE_CP_SIGNING_PUBLIC_KEY` in PEM format), and `COVE_CP_TUNNEL_SECRET`. For push notifications, configure the same provider credentials and, for APNs, the same `COVE_CP_APNS_JOB_SECRET`. When expanding an existing installation, reuse its signing keys and secrets to preserve issued credentials.
2. Give each replica a separate persistent `COVE_CP_DATA_DIR`. Start each once with its local listen settings to generate its peer key and read `libp2pPeerId` from the startup log. Keep that key with the same hostname across restarts.
3. Set `COVE_CP_LIBP2P_REPLICAS` to the same comma-separated list on every replica, including its own address. In this mode each replica advertises the entries ending in its own peer ID. Environments use the full list to maintain reservations. Restart environment hosts with updated runtime configuration after adding relay addresses.

   ```dotenv
   COVE_CP_LIBP2P_REPLICAS=/dns4/relay-a.example.com/tcp/443/tls/ws/p2p/<peer-A>,/dns4/relay-b.example.com/tcp/443/tls/ws/p2p/<peer-B>
   ```

4. With `DATABASE_URL` set, run `node infra/cp/src/bin.ts --migrate-only` once from the image or repository root. Set `COVE_CP_AUTO_MIGRATE=false` on the serving replicas and roll them out. Automatic startup migrations also serialize through a PostgreSQL advisory lock.

Verify that `/.well-known/cove-control-plane` lists both peers. Connect an environment, then check that its authenticated `GET /v1/environments` response includes both relay addresses. Stop one replica and open a new client connection through the surviving one. Graceful shutdown withdraws routes immediately. After an abrupt loss, discovery drops the failed replica within 45 seconds of its last heartbeat. Clients must reconnect streams that used the failed relay.

Any replica can forward a webhook or environment probe through an active relay. When offline webhook holding is enabled, PostgreSQL stores requests and workers retry delivery for up to 24 hours. A replacement worker retries with the same delivery ID. Push jobs also survive replica restarts. A crash after a provider accepts a notification but before acknowledgement can cause repeat delivery.
