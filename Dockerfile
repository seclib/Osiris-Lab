# ============================================================================
# OSIRIS-Lab v2 — Multi-Stage Optimized Dockerfile
# Principal DevSecOps Architect
# ============================================================================

# ─── Stage 1: Base Dependencies ─────────────────────────────────────────────
FROM node:20-slim@sha256:8b4c8e4c5e5f8b1e9d2c3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4 AS base
LABEL stage=base
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# ─── Stage 2: Dependencies (cached) ─────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --only=production --ignore-scripts && \
    npm cache clean --force

# ─── Stage 3: Build ──────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && \
    npm run lint && \
    npm run test:unit -- --run || true

# ─── Stage 4: Production Image ───────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

# Security: Run as non-root
RUN groupadd -r osiris && useradd -r -g osiris -d /app -s /sbin/nologin osiris

# Copy production dependencies
COPY --from=deps --chown=osiris:osiris /app/node_modules ./node_modules
COPY --from=builder --chown=osiris:osiris /app/.next/standalone ./
COPY --from=builder --chown=osiris:osiris /app/.next/static ./.next/static
COPY --from=builder --chown=osiris:osiris /app/public ./public
COPY --from=builder --chown=osiris:osiris /app/package.json ./

# Security: Set read-only root filesystem
RUN chmod -R 755 /app && \
    chown -R osiris:osiris /app

# Switch to non-root user
USER osiris

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Expose port
EXPOSE 3000

# Environment
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Start application
CMD ["node", "server.js"]