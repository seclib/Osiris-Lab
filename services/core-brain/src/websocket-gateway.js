'use strict';

const { WebSocketHub } = require('./ws-hub');

class WebSocketGateway extends WebSocketHub {}

module.exports = {
  WebSocketGateway,
};

