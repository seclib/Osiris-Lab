'use strict';

const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;

function parseFilters(req) {
  const url = new URL(req.url, 'http://localhost');
  const type = url.searchParams.get('type');
  return {
    type: type === 'aircraft' || type === 'vessel' ? type : null,
  };
}

class StreamHub {
  constructor(store, logger) {
    this.store = store;
    this.logger = logger;
    this.wss = new WebSocketServer({ noServer: true });
    this.clients = new Map();
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

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      this.send(ws, {
        type: 'hello',
        service: 'osiris-tracking-service',
        time: new Date().toISOString(),
      });

      this.send(ws, {
        type: 'snapshot',
        tracks: this.store.list({
          type: filters.type,
          limit: 5000,
        }),
        time: new Date().toISOString(),
      });
    });

    this.heartbeat = setInterval(() => this.checkClients(), 30000);
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

  broadcastTrack(track) {
    const payload = {
      type: 'track.update',
      track,
      time: new Date().toISOString(),
    };

    for (const [ws, state] of this.clients.entries()) {
      if (state.filters.type && state.filters.type !== track.type) continue;
      this.send(ws, payload);
    }
  }

  summary() {
    return {
      clients: this.clients.size,
    };
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.wss.close();
  }
}

module.exports = { StreamHub };
