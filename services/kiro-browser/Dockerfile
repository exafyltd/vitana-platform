# VTID-05070 kiro-browser: the read-only staging screenshot SIDECAR of the kiro-runner task.
# A second container in the kiro-runner Fargate task definition; listens on 127.0.0.1:8090.
#
# Base: the official Playwright image, PINNED by tag AND digest (MCR, Microsoft's own registry,
# not Docker Hub). It ships Chromium for exactly Playwright 1.58.2, so package.json pins
# playwright-core to the same version. Bumping is a deliberate edit of the tag, the digest and
# package.json together.
#   mcr.microsoft.com/playwright:v1.58.2-noble
#   digest read 2026-10-10 from https://mcr.microsoft.com/v2/playwright/manifests/v1.58.2-noble
#
# Non-root (pwuser, the image's own user). The task definition runs it with a read-only root
# filesystem and a writable /tmp volume; HOME and the browser profile live in /tmp.
# Chromium's sandbox is tried first; see src/index.ts for the KIRO_BROWSER_NO_SANDBOX fallback.

FROM mcr.microsoft.com/playwright:v1.58.2-noble@sha256:6446946a1d9fd62d9ae501312a2d76a43ee688542b21622056a372959b65d63d AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.58.2-noble@sha256:6446946a1d9fd62d9ae501312a2d76a43ee688542b21622056a372959b65d63d AS runtime
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
# Fails the build when the image's Chromium is not the one playwright-core 1.58.2 expects.
RUN node -e "const p=require('playwright-core');const fs=require('fs');const x=p.chromium.executablePath();if(!fs.existsSync(x)){console.error('chromium missing: '+x);process.exit(1)}"
ENV NODE_ENV=production KIRO_BROWSER_PORT=8090 HOME=/tmp TMPDIR=/tmp
USER pwuser
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/index.js"]
