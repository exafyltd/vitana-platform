FROM node:20-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm i -g pnpm && pnpm install
COPY . .
RUN pnpm prisma generate
CMD ["sh", "-c", "pnpm prisma migrate deploy && psql $DATABASE_URL -f database/policies/002_oasis_events.sql"]
