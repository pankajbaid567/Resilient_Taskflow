# syntax=docker/dockerfile:1.4

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files for dependency installation
COPY package.json pnpm-lock.yaml* ./
COPY apps/dashboard/package.json ./apps/dashboard/

# Install pnpm
RUN npm install -g pnpm@8.15.0

# Install dependencies
RUN pnpm install --frozen-lockfile --prefer-offline

# Copy source code
COPY apps/dashboard ./apps/dashboard
COPY tsconfig.json ./

# Build the application
WORKDIR /app/apps/dashboard
RUN pnpm build

# Production stage
FROM nginx:alpine

# Create non-root user
RUN addgroup -g 101 -S nginx && \
    adduser -S nginx -u 101 -G nginx

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Copy custom nginx config
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets from builder stage
COPY --from=builder /app/apps/dashboard/dist /usr/share/nginx/html

# Set proper permissions
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chown -R nginx:nginx /var/cache/nginx && \
    chown -R nginx:nginx /var/log/nginx && \
    chown -R nginx:nginx /etc/nginx/conf.d && \
    touch /var/run/nginx.pid && \
    chown -R nginx:nginx /var/run/nginx.pid

# Switch to non-root user
USER nginx

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:80/health || exit 1

# Expose port
EXPOSE 80

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
