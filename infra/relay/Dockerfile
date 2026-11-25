FROM node:24-slim

ENV NODE_ENV=production

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.14.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY infra/relay/package.json infra/relay/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/client-runtime/package.json packages/client-runtime/package.json
COPY packages/libp2p-tunnel/package.json packages/libp2p-tunnel/package.json

RUN pnpm install --frozen-lockfile --filter t3code-relay...

COPY packages/contracts packages/contracts
COPY packages/shared packages/shared
COPY packages/client-runtime packages/client-runtime
COPY packages/libp2p-tunnel packages/libp2p-tunnel
COPY infra/relay infra/relay

EXPOSE 8787 4001 4002

CMD ["pnpm", "--filter", "t3code-relay", "exec", "vite-plus", "run", "start"]
