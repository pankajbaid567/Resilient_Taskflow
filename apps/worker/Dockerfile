# syntax=docker/dockerfile:1.7
# Build context: repository root.  docker build -f apps/worker/Dockerfile .

FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY tests/package.json ./tests/package.json
RUN pnpm install --frozen-lockfile --filter "@taskflow/worker-app..."

COPY tsconfig.json turbo.json ./
RUN pnpm --filter @taskflow/worker-app... build

RUN pnpm --filter @taskflow/worker-app deploy --prod /out

FROM node:20-alpine AS production
RUN apk add --no-cache dumb-init
WORKDIR /app
COPY --from=builder --chown=node:node /out ./

# The worker image also carries @taskflow/database (dist + SQL migrations), so
# the one-shot `migrate` service reuses it:
#   node node_modules/@taskflow/database/dist/migrate.js
ENV NODE_ENV=production \
    WORKER_CONCURRENCY=10 \
    WORKER_QUEUES=default,email,critical,low \
    WORKER_METRICS_PORT=9464

USER node

# The worker serves no application traffic. Liveness: the metrics endpoint
# (WORKER_METRICS_PORT, 0 disables it and so the check) answers.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "const p=process.env.WORKER_METRICS_PORT||9464;if(p==='0')process.exit(0);fetch('http://127.0.0.1:'+p+'/metrics').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
