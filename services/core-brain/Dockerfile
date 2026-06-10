FROM node:20-alpine AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S osiris && adduser -S osiris -G osiris

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src

USER osiris

EXPOSE 4400

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4400/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
