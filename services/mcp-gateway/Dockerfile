# Builder stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies (prod + dev, needed for TypeScript build)
COPY package*.json ./
RUN npm install

# Copy TS config and source
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript -> dist/
RUN npm run build

# Runtime stage
FROM node:20-alpine AS runner

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy built JS only
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Start the MCP Gateway from the compiled entrypoint
CMD ["node", "dist/index.js"]
