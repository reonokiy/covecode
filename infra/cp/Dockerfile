FROM node:24-slim

ENV NODE_ENV=production

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.14.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY patches patches
COPY packages packages
COPY infra/cp/package.json infra/cp/package.json

RUN pnpm_config_fetch_timeout=300000 pnpm --filter-prod cove-cp... install --prod --frozen-lockfile --ignore-scripts

COPY infra/cp/src infra/cp/src
COPY infra/cp/migrations infra/cp/migrations

EXPOSE 8787 4001 4002

CMD ["node", "infra/cp/src/bin.ts"]
