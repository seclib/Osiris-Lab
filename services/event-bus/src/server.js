'use strict';

const http = require('http');

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function createServer({ config, logger, bus, workers, consumer }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    try {
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/ready')) {
        const streamLength = await bus.streamLength();
        const pending = await bus.pendingCount();
        const workerHealth = workers.map((worker) => worker.health());
        const degradedWorkers = workerHealth.filter((worker) => worker.enabled && worker.state !== 'ok' && worker.state !== 'starting');
        const redis = bus.health();
        const ready = redis.connected && (config.mode === 'ingest' || config.mode === 'all' || consumer);

        return sendJson(res, url.pathname === '/ready' && !ready ? 503 : 200, {
          status: redis.connected && degradedWorkers.length === 0 ? 'OK' : 'DEGRADED',
          service: config.serviceName,
          mode: config.mode,
          redis,
          stream: {
            key: config.redis.streamKey,
            length: streamLength,
            pending,
            dlq: config.redis.dlqStreamKey,
          },
          workers: workerHealth,
          consumer: consumer ? consumer.health() : null,
          time: new Date().toISOString(),
        });
      }

      if (req.method === 'GET' && url.pathname === '/metrics') {
        const streamLength = await bus.streamLength();
        const pending = await bus.pendingCount();
        const workerLines = workers.flatMap((worker) => {
          const health = worker.health();
          const up = health.enabled && (health.state === 'ok' || health.state === 'starting') ? 1 : 0;
          return [
            `osiris_event_feed_up{feed="${health.id}",state="${health.state}"} ${up}`,
            `osiris_event_feed_published_total{feed="${health.id}"} ${health.published}`,
            `osiris_event_feed_rejected_total{feed="${health.id}"} ${health.rejected}`,
          ];
        });
        return sendText(res, 200, [
          `osiris_event_stream_length ${streamLength}`,
          `osiris_event_stream_pending ${pending}`,
          `osiris_event_bus_published_total ${bus.health().published}`,
          `osiris_event_bus_dlq_total ${bus.health().dlq}`,
          ...(consumer ? [
            `osiris_event_consumer_processed_total ${consumer.health().processed}`,
            `osiris_event_consumer_failed_total ${consumer.health().failed}`,
            `osiris_event_consumer_dlq_total ${consumer.health().dlq}`,
          ] : []),
          ...workerLines,
          '',
        ].join('\n'));
      }

      return sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      logger.error('event_bus_request_failed', {
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      return sendJson(res, 500, { error: 'internal_error' });
    }
  });
}

module.exports = { createServer };
