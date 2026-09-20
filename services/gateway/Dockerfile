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

# VTID-04118 — RepoWise + Graphify codebase-intelligence CLIs, baked into
# the runtime image (VTID-04116 shipped the Operator Console's dev_repowise/
# dev_graphify tools and the SessionStart hook, but this image had neither
# tool nor an index for either to use, so both tools reported
# not_configured on every real deployment — flagged as the explicit
# follow-up in that VTID's own acceptance doc).
#
# codeintel-src/platform and codeintel-src/vitana-v1 are staged by
# AWS-STAGE-DEPLOY-GATEWAY.yml BEFORE `docker build` runs (full source +
# .git history for each repo, node_modules/dist/build artifacts excluded) —
# this Dockerfile only COPYs and indexes what the workflow already staged
# inside the `services/gateway` build context; it does not check out either
# repo itself. Both source directories always exist (the workflow creates
# an empty vitana-v1 placeholder if the cross-repo checkout is skipped/
# fails), so this COPY never fails the build regardless of that outcome.
#
# Deliberately best-effort: `pip install`/`graphify update`/`repowise init`
# all run inside one `|| true`-guarded block so a transient PyPI hiccup or a
# slow index build degrades to dev_repowise/dev_graphify reporting a real
# CLI error at runtime, never a failed gateway deploy (the same posture
# every other optional provider in this file — Fish, ERP bridge, Vertex
# bridge — already uses).
COPY codeintel-src/platform /repo-platform
COPY codeintel-src/vitana-v1 /repo-vitana-v1
RUN ( apk add --no-cache python3 py3-pip git \
      && pip install --break-system-packages --no-cache-dir repowise graphifyy \
      && export PATH="/root/.local/bin:$PATH" \
      && ( [ -d /repo-platform/.git ] && cd /repo-platform \
           && graphify update . --no-cluster || echo "[codeintel] graphify skipped for /repo-platform" ) \
      && ( [ -d /repo-platform/.git ] && cd /repo-platform \
           && repowise init --no-prose -y || echo "[codeintel] repowise skipped for /repo-platform" ) \
      && ( [ -d /repo-vitana-v1/.git ] && cd /repo-vitana-v1 \
           && graphify update . --no-cluster || echo "[codeintel] graphify skipped for /repo-vitana-v1" ) \
      && ( [ -d /repo-vitana-v1/.git ] && cd /repo-vitana-v1 \
           && repowise init --no-prose -y || echo "[codeintel] repowise skipped for /repo-vitana-v1" ) \
    ) || echo "[codeintel] setup failed non-fatally — dev_repowise/dev_graphify will report a real error at runtime"
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/events/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"
CMD ["node", "dist/index.js"]
