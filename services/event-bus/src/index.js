'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { RedisStreamBus } = require('./redis-stream-bus');
const { PollingFeedWorker } = require('./polling-worker');
const { StreamConsumer } = require('./stream-consumer');
const { createServer } = require('./server');

const config = loadConfig();
const logger = createLogger(config.serviceName, config.logLevel);
const bus = new RedisStreamBus(config, logger);

let shuttingDown = false;

const ingestEnabled = config.mode === 'all' || config.mode === 'ingest';
const consumeEnabled = config.mode === 'all' || config.mode === 'consume';
const workers = ingestEnabled
  ? config.feeds.map((feed) => new PollingFeedWorker(feed, config, logger, bus))
  : [];
const consumer = consumeEnabled ? new StreamConsumer(config, logger, bus) : null;

const server = createServer({
  config,
  logger,
  bus,
  workers,
  consumer,
});

async function start() {
  await bus.connect();
  if (consumeEnabled) await bus.ensureGroup();

  server.listen(config.port, config.host, () => {
    logger.info('event_bus_listening', {
      host: config.host,
      port: config.port,
      stream: config.redis.streamKey,
      mode: config.mode,
      ingestEnabled,
      consumeEnabled,
    });
  });

  for (const worker of workers) worker.start();
  if (consumer) consumer.start();
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('event_bus_shutdown_started', { signal });

  for (const worker of workers) worker.stop();
  if (consumer) consumer.stop();

  await new Promise((resolve) => {
    server.close(resolve);
    setTimeout(resolve, config.shutdownGraceMs).unref();
  });

  await bus.close();
  logger.info('event_bus_shutdown_complete');
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    logger.error('event_bus_shutdown_failed', { error: error.message });
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    logger.error('event_bus_shutdown_failed', { error: error.message });
    process.exit(1);
  });
});

start().catch((error) => {
  logger.error('event_bus_start_failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
