# syntax=docker/dockerfile:1.7
# Build context: repository root.  docker build -f apps/api/Dockerfile .

FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate
WORKDIR /app

# Install with the full lockfile first so this layer is cached until deps change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY tests/package.json ./tests/package.json
RUN pnpm install --frozen-lockfile --filter "@taskflow/api..."

COPY tsconfig.json turbo.json ./
RUN pnpm --filter @taskflow/api... build

# Produce a self-contained, production-only tree for the API.
RUN pnpm --filter @taskflow/api deploy --prod /out

FROM node:20-alpine AS production
RUN apk add --no-cache dumb-init
WORKDIR /app
COPY --from=builder --chown=node:node /out ./

ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=3000 \
    API_SHUTDOWN_TIMEOUT_MS=30000

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
