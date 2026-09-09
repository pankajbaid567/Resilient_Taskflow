# syntax=docker/dockerfile:1.4

# Build stage
FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files for dependency installation
COPY package.json pnpm-lock.yaml* ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/*/package.json ./packages/*/

# Install pnpm
RUN npm install -g pnpm@8.15.0

# Install dependencies
RUN pnpm install --frozen-lockfile --prefer-offline

# Copy source code
COPY . .

# Build the application
WORKDIR /app/apps/worker
RUN pnpm build

# Remove dev dependencies
WORKDIR /app
RUN pnpm prune --prod

# Production stage
FROM node:20-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./
COPY --from=builder --chown=nodejs:nodejs /app/pnpm-lock.yaml* ./
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules

# Copy built application
COPY --from=builder --chown=nodejs:nodejs /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder --chown=nodejs:nodejs /app/apps/worker/package.json ./apps/worker/

# Copy shared packages
COPY --from=builder --chown=nodejs:nodejs /app/packages ./packages

# Set environment variables
ENV NODE_ENV=production \
    # Worker concurrency (jobs processed in parallel per worker)
    WORKER_CONCURRENCY=10 \
    # Graceful shutdown timeout (allow current jobs to finish)
    SHUTDOWN_TIMEOUT=60000 \
    # Queues to process (comma-separated)
    WORKER_QUEUES=default,high-priority,low-priority

# Switch to non-root user
USER nodejs

# No exposed ports (worker doesn't serve HTTP)

# Health check - check if worker process is running
# In production, use external health monitoring
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD pgrep -f "node.*worker" > /dev/null || exit 1

# Use dumb-init to handle signals properly (SIGTERM for graceful shutdown)
ENTRYPOINT ["dumb-init", "--"]

# Start the worker
CMD ["node", "apps/worker/dist/index.js"]
