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
    'content-type': 'text/plain; version=0.0.4',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function createServer({ config, bus, agent }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const health = {
      service: config.serviceName,
      enabled: config.enabled,
      status: !config.enabled ? 'DISABLED' : bus.connected ? 'OK' : 'DEGRADED',
      bus: bus.health(),
      agent: agent.health(),
      time: new Date().toISOString(),
    };

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
      return sendJson(res, 200, health);
    }

    if (req.method === 'GET' && url.pathname === '/ready') {
      const ready = !config.enabled || bus.connected;
      return sendJson(res, ready ? 200 : 503, health);
    }

    if (req.method === 'GET' && url.pathname === '/metrics') {
      const stats = agent.health();
      return sendText(res, 200, [
        `osiris_agent_up ${bus.connected ? 1 : 0}`,
        `osiris_agent_consumed_total ${stats.consumed}`,
        `osiris_agent_processed_total ${stats.processed}`,
        `osiris_agent_published_total ${stats.published}`,
        `osiris_agent_skipped_total ${stats.skipped}`,
        `osiris_agent_failed_total ${stats.failed}`,
        `osiris_agent_dlq_total ${stats.dlq}`,
        `osiris_agent_inflight ${stats.inFlight}`,
        `osiris_agent_ollama_attempted_total ${stats.ollama.attempted}`,
        `osiris_agent_ollama_succeeded_total ${stats.ollama.succeeded}`,
        '',
      ].join('\n'));
    }

    return sendJson(res, 404, { error: 'not_found' });
  });
}

module.exports = { createServer };
