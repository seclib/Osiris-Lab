FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S osiris && adduser -S osiris -G osiris
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY base-sensor.js event-schema.js registry.js ./
COPY firms/src ./firms/src
USER osiris
EXPOSE 4703
CMD ["node", "firms/src/index.js"]
