FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build
RUN npm prune --production

FROM node:20-alpine AS production

LABEL maintainer="Vitana Platform"
LABEL vtid="VTID-02401"
LABEL component="vaea-economic-actor"

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY manifest.json ./

RUN chown -R nodejs:nodejs /app
USER nodejs

ENV NODE_ENV=production
ENV PORT=8080
ENV VAEA_ENABLED=false
ENV VAEA_AUTO_EXECUTE_ENABLED=false
ENV VAEA_PHASE_1_OBSERVE_ENABLED=false
ENV VAEA_OBSERVE_INTERVAL_MS=300000

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/alive || exit 1

CMD ["node", "dist/index.js"]
