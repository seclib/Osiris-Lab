'use strict';

const http = require('http');

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; version=0.0.4',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function createServer({ config, publisher, workers, wsHub }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const feedStates = workers.map((worker) => worker.health());
    const enabledFeeds = feedStates.filter((feed) => feed.enabled);
    const degradedFeeds = enabledFeeds.filter((feed) => feed.status === 'DEGRADED');
    const body = {
      service: config.serviceName,
      enabled: config.enabled,
      status: !config.enabled
        ? 'DISABLED'
        : !publisher.connected
          ? 'DEGRADED'
          : degradedFeeds.length
            ? 'DEGRADED'
            : 'OK',
      redis: publisher.health(),
      websocket: wsHub?.summary() || null,
      feeds: feedStates,
      time: new Date().toISOString(),
    };

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
      return sendJson(res, 200, body);
    }

    if (req.method === 'GET' && url.pathname === '/ready') {
      const ready = !config.enabled || publisher.connected;
      return sendJson(res, ready ? 200 : 503, body);
    }

    if (req.method === 'GET' && url.pathname === '/metrics') {
      const lines = [
        `osiris_brain_up ${publisher.connected ? 1 : 0}`,
        `osiris_brain_events_published_total ${publisher.stats.published}`,
        `osiris_brain_events_rejected_total ${publisher.stats.rejected}`,
        `osiris_brain_backpressure_skips_total ${publisher.stats.backpressureSkips}`,
        ...feedStates.flatMap((feed) => [
          `osiris_brain_feed_up{feed="${feed.id}",status="${feed.status}"} ${feed.status === 'OK' || feed.status === 'DISABLED' ? 1 : 0}`,
          `osiris_brain_feed_polls_total{feed="${feed.id}"} ${feed.polls}`,
          `osiris_brain_feed_published_total{feed="${feed.id}"} ${feed.published}`,
          `osiris_brain_feed_rejected_total{feed="${feed.id}"} ${feed.rejected}`,
        ]),
        '',
      ];
      return sendText(res, 200, lines.join('\n'));
    }

    return sendJson(res, 404, { error: 'not_found' });
  });

  wsHub?.attach(server);
  return server;
}

module.exports = { createServer };
