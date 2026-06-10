'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { RedisCache } = require('./redis-cache');
const { createServer } = require('./server');
const { StreamHub } = require('./stream');
const { TrackStore } = require('./store');
const { AdsbProvider } = require('./providers/adsb');
const { AisProvider } = require('./providers/ais');

const config = loadConfig();
const logger = createLogger(config.serviceName, config.logLevel);
const store = new TrackStore(config);
const cache = new RedisCache(config, logger);
const streamHub = new StreamHub(store, logger);

let shuttingDown = false;

async function publishTracks(source, tracks, normalizationRejected = []) {
  const result = store.upsertMany(tracks);

  for (const track of result.accepted) {
    streamHub.broadcastTrack(track);
    await cache.writeTrack(track);
  }

  if (normalizationRejected.length || result.rejected.length) {
    logger.warn('tracks_rejected', {
      source,
      normalizationRejected: normalizationRejected.length,
      storeRejected: result.rejected.length,
    });
  }

  return {
    accepted: result.accepted.length,
    rejected: result.rejected.length,
  };
}

const providers = [
  new AdsbProvider(config, logger, publishTracks),
  new AisProvider(config, logger, publishTracks),
];

async function publishProviderHealth() {
  await Promise.all(providers.map(async (provider) => {
    const health = provider.health();
    await cache.writeModuleHealth(health.name, health);
  }));
}

const server = createServer({
  config,
  logger,
  store,
  streamHub,
  cache,
  providers,
  publishTracks,
});

async function start() {
  await cache.connect();

  server.listen(config.port, config.host, () => {
    logger.info('tracking_service_listening', {
      host: config.host,
      port: config.port,
      adsbEnabled: config.adsb.enabled,
      aisEnabled: config.ais.enabled,
      redisEnabled: config.redis.enabled,
    });
  });

  for (const provider of providers) provider.start();
  await publishProviderHealth();

  setInterval(() => {
    const deleted = store.pruneExpired();
    if (deleted > 0) logger.info('expired_tracks_pruned', { deleted });
  }, 60000).unref();

  setInterval(() => {
    publishProviderHealth().catch((error) => {
      logger.warn('provider_health_publish_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 15000).unref();
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('tracking_service_shutdown_started', { signal });

  for (const provider of providers) provider.stop();
  streamHub.close();

  await new Promise((resolve) => {
    server.close(resolve);
    setTimeout(resolve, config.shutdownGraceMs).unref();
  });

  await cache.close();
  logger.info('tracking_service_shutdown_complete');
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    logger.error('shutdown_failed', { error: error.message });
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    logger.error('shutdown_failed', { error: error.message });
    process.exit(1);
  });
});

start().catch((error) => {
  logger.error('tracking_service_start_failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
