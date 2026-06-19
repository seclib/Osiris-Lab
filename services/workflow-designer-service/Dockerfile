FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json tsconfig.json ./
RUN npm ci

# Copy source
COPY src/ ./src/

# Build
RUN npm run build

# Production image
FROM node:20-alpine AS runner

WORKDIR /app

# Install production dependencies only
COPY package.json ./
RUN npm ci --omit=dev

# Copy built artifacts
COPY --from=builder /app/dist ./dist

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

USER node

EXPOSE 4000

CMD ["node", "dist/index.js"]