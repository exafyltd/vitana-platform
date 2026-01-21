# VTID-01200: Worker Runner Execution Plane - Dockerfile
#
# Multi-stage build for Cloud Run deployment.
# Optimized for small image size and fast cold starts.

# =============================================================================
# Stage 1: Builder
# =============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Prune devDependencies for production
RUN npm prune --production

# =============================================================================
# Stage 2: Production
# =============================================================================
FROM node:20-alpine AS production

# Add labels
LABEL maintainer="Vitana Platform"
LABEL vtid="VTID-01200"
LABEL component="worker-runner-execution-plane"

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

WORKDIR /app

# Copy built files and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Copy manifest for runtime info
COPY manifest.json ./

# Set ownership
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Environment defaults
ENV NODE_ENV=production
ENV PORT=8080
ENV POLL_INTERVAL_MS=5000
ENV WORKER_ID_PREFIX=worker-runner
ENV AUTOPILOT_LOOP_ENABLED=true

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start the service
CMD ["node", "dist/index.js"]
