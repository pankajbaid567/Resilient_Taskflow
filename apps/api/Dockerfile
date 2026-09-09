# syntax=docker/dockerfile:1.4

# Build stage
FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files for dependency installation
COPY package.json pnpm-lock.yaml* ./
COPY apps/api/package.json ./apps/api/
COPY packages/*/package.json ./packages/*/

# Install pnpm
RUN npm install -g pnpm@8.15.0

# Install dependencies
RUN pnpm install --frozen-lockfile --prefer-offline

# Copy source code
COPY . .

# Build the application
WORKDIR /app/apps/api
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
COPY --from=builder --chown=nodejs:nodejs /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=nodejs:nodejs /app/apps/api/package.json ./apps/api/

# Copy shared packages
COPY --from=builder --chown=nodejs:nodejs /app/packages ./packages

# Set environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    # Graceful shutdown timeout
    SHUTDOWN_TIMEOUT=30000

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/v1/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => { process.exit(1); });"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "apps/api/dist/index.js"]
