'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { RedisPublisher } = require('./redis-publisher');
const { BridgeWorker, EventDeduper } = require('./bridge-worker');
const { createServer } = require('./server');

const config = loadConfig();
const logger = createLogger(config.serviceName, config.logLevel);
const publisher = new RedisPublisher(config, logger);
const deduper = new EventDeduper(config.dedupeTtlMs);
const workers = config.feeds.map((feed) => new BridgeWorker(feed, config, logger, publisher, deduper));
const server = createServer({ config, publisher, workers });

let shuttingDown = false;

async function start() {
  await publisher.connect();

  server.listen(config.port, config.host, () => {
    logger.info('osiris_brain_listening', {
      host: config.host,
      port: config.port,
      enabled: config.enabled,
      stream: config.redis.streamKey,
      feeds: config.feeds.map((feed) => ({ id: feed.id, type: feed.type, url: feed.url, enabled: feed.enabled })),
    });
  });

  for (const worker of workers) worker.start();
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('osiris_brain_shutdown_started', { signal });

  for (const worker of workers) worker.stop();

  await new Promise((resolve) => {
    server.close(resolve);
    setTimeout(resolve, config.shutdownGraceMs).unref();
  });

  await publisher.close();
  logger.info('osiris_brain_shutdown_complete');
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    logger.error('osiris_brain_shutdown_failed', { error: error.message });
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    logger.error('osiris_brain_shutdown_failed', { error: error.message });
    process.exit(1);
  });
});

start().catch((error) => {
  logger.error('osiris_brain_start_failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
