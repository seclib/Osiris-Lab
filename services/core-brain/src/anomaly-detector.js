'use strict';

const { detectAnomalies } = require('./anomaly-engine');

class AnomalyDetector {
  constructor(config, state) {
    this.config = config;
    this.state = state;
  }

  detect(event, context) {
    return detectAnomalies(event, context, this.state, this.config);
  }
}

module.exports = {
  AnomalyDetector,
};

