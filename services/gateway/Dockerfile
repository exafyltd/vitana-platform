FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./
RUN npm install
COPY BUILD_INFO ./
COPY src ./src
COPY config ./config
COPY specs ./specs
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
# VTID-03773 — RDS CA bundle, baked in at build time (not fetched at
# container start — an ECS task's egress shouldn't be a precondition for a
# TLS handshake it needs on every boot). aurora-client.ts's own
# resolveSsl() defaults to `rejectUnauthorized: true` against the SYSTEM
# trust store when AURORA_CA_BUNDLE_PATH is unset, and that verification
# fails against RDS's cert by design — this is the file it fails against
# once AURORA_CA_BUNDLE_PATH is pointed here. Same URL
# scripts/db-i18n/seed-aurora.sh already downloads for the manual bastion
# flow (see docs/DB-CONTENT-I18N.md), now baked into the image instead of
# fetched ad hoc.
RUN apk add --no-cache ffmpeg curl ca-certificates \
  && mkdir -p /app/certs \
  && curl -fsSL -o /app/certs/rds-combined-ca-bundle.pem \
       "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem" \
  && npm install --production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/config ./config
COPY --from=builder /app/specs ./specs
COPY BUILD_INFO ./
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/events/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"
CMD ["node", "dist/index.js"]
