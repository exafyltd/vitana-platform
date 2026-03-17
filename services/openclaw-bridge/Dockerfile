FROM node:22-slim AS builder

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile 2>/dev/null || pnpm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

FROM node:22-slim AS runtime

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

ENV NODE_ENV=production
ENV OPENCLAW_HOME=/opt/vitana-autopilot
EXPOSE 8080

CMD ["node", "dist/index.js"]
