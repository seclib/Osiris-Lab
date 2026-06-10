'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { AgentBus } = require('./agent-bus');
const { StreamAgent } = require('./stream-agent');
const { createServer } = require('./server');

const config = loadConfig();
const logger = createLogger(config.serviceName, config.logLevel);
const bus = new AgentBus(config, logger);
const agent = new StreamAgent(config, logger, bus);
const server = createServer({ config, bus, agent });

let shuttingDown = false;

async function start() {
  await bus.connect();
  await bus.ensureGroup();

  server.listen(config.port, config.host, () => {
    logger.info('osiris_agent_listening', {
      host: config.host,
      port: config.port,
      enabled: config.enabled,
      inputStream: config.redis.inputStream,
      outputStream: config.redis.outputStream,
      ollamaEnabled: config.ollama.enabled,
    });
  });

  agent.start();
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('osiris_agent_shutdown_started', { signal });
  agent.stop();
  await agent.drain(config.shutdownGraceMs);

  await new Promise((resolve) => {
    server.close(resolve);
    setTimeout(resolve, config.shutdownGraceMs).unref();
  });

  await bus.close();
  logger.info('osiris_agent_shutdown_complete');
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    logger.error('osiris_agent_shutdown_failed', { error: error.message });
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    logger.error('osiris_agent_shutdown_failed', { error: error.message });
    process.exit(1);
  });
});

start().catch((error) => {
  logger.error('osiris_agent_start_failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
