# VTID-04999 kiro-runner. Private ECS service (staging), port 8080, /alive.
#
# kiro-cli is PINNED: one versioned release archive from Kiro's own download
# host, checked against the sha256 Kiro publishes in its release manifest
# (https://prod.download.cli.kiro.dev/stable/latest/manifest.json, entry
# "2.28.0/kirocli-x86_64-linux.tar.xz", targetTriple x86_64-unknown-linux-gnu).
# No `curl | bash`. Bumping is a deliberate edit of both ARGs below.
# The gnu build needs glibc >= 2.34; bookworm ships 2.36.

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim AS kiro
ARG KIRO_CLI_VERSION=2.28.0
ARG KIRO_CLI_SHA256=f48ef68df4cc7e83c942ce17e15d2a2c4316d08c6eba8829c4a7b277eba7be5b
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/kirocli.tar.xz \
      "https://prod.download.cli.kiro.dev/stable/${KIRO_CLI_VERSION}/kirocli-x86_64-linux.tar.xz" \
 && echo "${KIRO_CLI_SHA256}  /tmp/kirocli.tar.xz" | sha256sum -c - \
 && mkdir -p /opt/kiro && tar -xJf /tmp/kirocli.tar.xz -C /opt/kiro && rm /tmp/kirocli.tar.xz \
 && grep -q "^BUILD_VERSION=${KIRO_CLI_VERSION}$" /opt/kiro/kirocli/BUILD-INFO

FROM node:20-bookworm-slim AS runtime
ARG KIRO_CLI_VERSION=2.28.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
COPY --from=kiro /opt/kiro/kirocli/bin/kiro-cli /opt/kiro/kirocli/bin/kiro-cli-chat /opt/kiro/kirocli/bin/kiro-cli-term /usr/local/bin/
# Fails the build when a shared library is missing on -slim or the binary is not the pinned one.
RUN kiro-cli --version | grep -qx "kiro-cli ${KIRO_CLI_VERSION}"
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
RUN mkdir -p /work && chown node:node /work
ENV NODE_ENV=production PORT=8080 KIRO_RUNNER_WORK_ROOT=/work KIRO_CLI_VERSION=${KIRO_CLI_VERSION}
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/index.js"]
