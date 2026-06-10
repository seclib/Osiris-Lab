FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node module-worker.js health-monitor.js ./

USER node

EXPOSE 4100 4190

CMD ["node", "module-worker.js"]
