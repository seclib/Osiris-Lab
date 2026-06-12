'use strict';

const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function eventConfidence(event) {
  const confidence = toNumber(event?.metadata?.confidence);
  if (confidence === null) return 0;
  return confidence <= 1 ? Math.round(confidence * 100) : Math.round(confidence);
}

function parseFilters(req) {
  const url = new URL(req.url, 'http://localhost');
  const type = url.searchParams.get('type');
  const minConfidence = toNumber(url.searchParams.get('minConfidence'));
  return {
    type: type ? type.toLowerCase() : null,
    minConfidence: minConfidence === null ? null : Math.max(0, Math.min(100, minConfidence)),
  };
}

class WebSocketHub {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.wss = new WebSocketServer({ noServer: true });
    this.clients = new Map();
    this.recent = [];
    this.heartbeat = null;
  }

  attach(server) {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/stream') return;

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws, req) => {
      const filters = parseFilters(req);
      this.clients.set(ws, { filters, alive: true });

      ws.on('pong', () => {
        const state = this.clients.get(ws);
        if (state) state.alive = true;
      });
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', (error) => {
        this.logger.warn('brain_ws_client_error', { error: error.message });
      });

      this.send(ws, {
        type: 'hello',
        service: this.config.serviceName,
        stream: this.config.redis.streamKey,
        time: new Date().toISOString(),
      });

      this.send(ws, {
        type: 'snapshot',
        events: this.recent.filter((event) => this.matches(event, filters)),
        time: new Date().toISOString(),
      });
    });

    this.heartbeat = setInterval(() => this.checkClients(), this.config.websocket.heartbeatMs);
  }

  matches(event, filters) {
    if (filters.type && event?.type !== filters.type) return false;
    if (filters.minConfidence !== null && eventConfidence(event) < filters.minConfidence) return false;
    return true;
  }

  checkClients() {
    for (const [ws, state] of this.clients.entries()) {
      if (!state.alive) {
        this.clients.delete(ws);
        ws.terminate();
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }

  send(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  remember(event) {
    if (this.config.websocket.snapshotMax <= 0) return;
    this.recent.push(event);
    if (this.recent.length > this.config.websocket.snapshotMax) {
      this.recent.splice(0, this.recent.length - this.config.websocket.snapshotMax);
    }
  }

  broadcastEvent(event) {
    this.remember(event);
    const payload = {
      type: 'event.update',
      event,
      time: new Date().toISOString(),
    };

    for (const [ws, state] of this.clients.entries()) {
      if (!this.matches(event, state.filters)) continue;
      this.send(ws, payload);
    }
  }

  broadcastEvents(events) {
    for (const event of events) this.broadcastEvent(event);
  }

  summary() {
    return {
      clients: this.clients.size,
      recent: this.recent.length,
      snapshotMax: this.config.websocket.snapshotMax,
    };
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.wss.close();
  }
}

module.exports = { WebSocketHub };
