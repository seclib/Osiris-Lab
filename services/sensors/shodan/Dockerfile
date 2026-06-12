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
COPY shodan ./shodan
USER osiris
EXPOSE 4705
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "const port=process.env.PORT||4705;fetch('http://127.0.0.1:'+port+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "shodan/index.js"]
