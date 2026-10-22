# syntax=docker/dockerfile:1.7
# Build context: repository root.  docker build -f apps/dashboard/Dockerfile .

FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY tests/package.json ./tests/package.json
RUN pnpm install --frozen-lockfile --filter "@taskflow/dashboard..."

# Leave unset to call the API through the same origin (/api/v1, proxied by
# nginx). Set only when the API lives on a different origin.
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}

COPY tsconfig.json ./
RUN pnpm --filter @taskflow/dashboard build

# nginx-unprivileged already runs as a non-root user (uid 101) on port 8080.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS production
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/dashboard/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/ || exit 1
