FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

COPY . .

RUN pnpm install --frozen-lockfile

RUN REMNIC_DOCKER_RUNTIME_BUILD=1 pnpm --filter @remnic/core build \
  && pnpm --filter @remnic/server exec tsup src/index.ts --format esm --target es2022 --platform node --outDir dist \
  && pnpm --filter @remnic/server run verify:bin \
  && CI=true pnpm prune --prod

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
  HOME=/data \
  REMNIC_HOME=/data \
  REMNIC_HOST=0.0.0.0 \
  REMNIC_PORT=4318 \
  REMNIC_MEMORY_DIR=/data/memory \
  REMNIC_ADMIN_CONSOLE_ENABLED=true \
  REMNIC_ADMIN_CONSOLE_PUBLIC_DIR=/app/admin-console/public

WORKDIR /app

RUN corepack enable \
  && mkdir -p /data /app \
  && chown -R node:node /data /app

COPY --from=build --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/admin-console ./admin-console

USER node

VOLUME ["/data"]
EXPOSE 4318

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=5 \
  CMD node -e "const headers={}; if (process.env.REMNIC_AUTH_TOKEN) headers.authorization='Bearer '+process.env.REMNIC_AUTH_TOKEN; fetch('http://127.0.0.1:4318/engram/v1/health',{headers}).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/remnic-server/bin/remnic-server.js", "--host", "0.0.0.0", "--port", "4318"]
