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

function createServer({ config, logger, bus, state, processor, wsHub }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    try {
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/ready')) {
        const redis = bus.health();
        const inputLength = await bus.streamLength(config.redis.inputStream);
        const outputLength = await bus.streamLength(config.redis.outputStream);
        const pending = await bus.pendingCount();
        const body = {
          status: config.enabled && redis.connected ? 'OK' : 'DEGRADED',
          service: config.serviceName,
          enabled: config.enabled,
          redis,
          streams: {
            input: config.redis.inputStream,
            inputLength,
            pending,
            output: config.redis.outputStream,
            outputLength,
            alerts: config.redis.alertStream,
            insights: config.redis.insightStream,
          },
          processor: processor.health(),
          state: state.summary(),
          websocket: wsHub.summary(),
          time: new Date().toISOString(),
        };
        return sendJson(res, url.pathname === '/ready' && (!config.enabled || !redis.connected) ? 503 : 200, body);
      }

      if (req.method === 'GET' && url.pathname === '/metrics') {
        const redis = bus.health();
        const inputLength = await bus.streamLength(config.redis.inputStream);
        const outputLength = await bus.streamLength(config.redis.outputStream);
        const insightLength = await bus.streamLength(config.redis.insightStream);
        const pending = await bus.pendingCount();
        const stateSummary = state.summary();
        const processorHealth = processor.health();
        return sendText(res, 200, [
          `osiris_brain_input_stream_length ${inputLength}`,
          `osiris_brain_output_stream_length ${outputLength}`,
          `osiris_brain_insight_stream_length ${insightLength}`,
          `osiris_brain_pending ${pending}`,
          `osiris_brain_processed_total ${processorHealth.processed}`,
          `osiris_brain_alerted_total ${processorHealth.alerted}`,
          `osiris_brain_failed_total ${processorHealth.failed}`,
          `osiris_brain_dlq_total ${processorHealth.dlq}`,
          `osiris_brain_insights_total ${bus.health().insights || 0}`,
          `osiris_brain_entities ${stateSummary.entityCount}`,
          `osiris_brain_hazards ${stateSummary.hazardCount}`,
          `osiris_brain_ws_clients ${wsHub.summary().clients}`,
          `osiris_brain_redis_connected ${redis.connected ? 1 : 0}`,
          '',
        ].join('\n'));
      }

      if (req.method === 'GET' && url.pathname === '/recent') {
        return sendJson(res, 200, {
          events: wsHub.recent.slice(-100),
          time: new Date().toISOString(),
        });
      }

      return sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      logger.error('core_brain_request_failed', {
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      return sendJson(res, 500, { error: 'internal_error' });
    }
  });

  wsHub.attach(server);
  return server;
}

module.exports = { createServer };
