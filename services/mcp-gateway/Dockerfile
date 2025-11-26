# =============================================================================
# MCP Gateway Dockerfile - 2-stage build
# =============================================================================

# Stage 1: Builder
FROM node:20-alpine AS builder
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including devDependencies for TypeScript)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript to JavaScript
RUN npm run build

# Stage 2: Runner
FROM node:20-alpine
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy compiled JavaScript from builder
COPY --from=builder /app/dist ./dist

# Expose port
EXPOSE 8080

# Run compiled JavaScript
CMD ["node", "dist/index.js"]
