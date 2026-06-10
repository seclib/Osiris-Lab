'use strict';

const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;

function parseFilters(req) {
  const url = new URL(req.url, 'http://localhost');
  const severity = url.searchParams.get('severity');
  const type = url.searchParams.get('type');
  return {
    severity: severity ? severity.toUpperCase() : null,
    type: type || null,
  };
}

class WebSocketHub {
  constructor(logger) {
    this.logger = logger;
    this.wss = new WebSocketServer({ noServer: true });
    this.clients = new Map();
    this.heartbeat = null;
    this.recent = [];
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

      this.send(ws, {
        type: 'hello',
        service: 'osiris-core-brain',
        time: new Date().toISOString(),
      });
      this.send(ws, {
        type: 'snapshot',
        events: this.recent.filter((item) => this.matches(item, filters)).slice(-100),
        time: new Date().toISOString(),
      });
    });

    this.heartbeat = setInterval(() => this.checkClients(), 30000);
  }

  matches(intelligence, filters) {
    if (filters.type && intelligence.source_event?.type !== filters.type) return false;
    if (filters.severity && intelligence.score?.severity !== filters.severity) return false;
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

  broadcast(intelligence) {
    this.recent.push(intelligence);
    if (this.recent.length > 500) this.recent.shift();

    const payload = {
      type: 'intelligence.update',
      intelligence,
      time: new Date().toISOString(),
    };

    for (const [ws, state] of this.clients.entries()) {
      if (!this.matches(intelligence, state.filters)) continue;
      this.send(ws, payload);
    }
  }

  summary() {
    return {
      clients: this.clients.size,
      recent: this.recent.length,
    };
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.wss.close();
  }
}

module.exports = { WebSocketHub };
