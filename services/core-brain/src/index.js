'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { BrainBus } = require('./brain-bus');
const { BrainStateStore } = require('./state-store');
const { StreamConsumer } = require('./stream-consumer');
const { WebSocketGateway } = require('./websocket-gateway');
const { createServer } = require('./server');

const config = loadConfig();
const logger = createLogger(config.serviceName, config.logLevel);
const bus = new BrainBus(config, logger);
const state = new BrainStateStore(config);
const wsHub = new WebSocketGateway(logger);
const processor = new StreamConsumer(config, logger, bus, state, wsHub);

let shuttingDown = false;

const server = createServer({
  config,
  logger,
  bus,
  state,
  processor,
  wsHub,
});

async function start() {
  if (!config.enabled) {
    logger.warn('core_brain_disabled');
  }

  await bus.connect();
  await bus.ensureGroup();

  server.listen(config.port, config.host, () => {
    logger.info('core_brain_listening', {
      host: config.host,
      port: config.port,
      inputStream: config.redis.inputStream,
      outputStream: config.redis.outputStream,
      alertStream: config.redis.alertStream,
      insightStream: config.redis.insightStream,
    });
  });

  if (config.enabled) processor.start();
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('core_brain_shutdown_started', { signal });

  processor.stop();
  wsHub.close();

  await new Promise((resolve) => {
    server.close(resolve);
    setTimeout(resolve, config.shutdownGraceMs).unref();
  });

  await bus.close();
  logger.info('core_brain_shutdown_complete');
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    logger.error('core_brain_shutdown_failed', { error: error.message });
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    logger.error('core_brain_shutdown_failed', { error: error.message });
    process.exit(1);
  });
});

start().catch((error) => {
  logger.error('core_brain_start_failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
