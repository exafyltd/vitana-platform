FROM node:18-alpine

# Install dependencies for Prisma on Alpine
RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

# Copy all source files
COPY package.json package-lock.json ./
COPY prisma ./prisma/
COPY src ./src/
COPY tsconfig.json ./

# Install dependencies and build
RUN npm install && \
    npx prisma generate && \
    npm run build && \
    npm prune --production

# Environment
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
