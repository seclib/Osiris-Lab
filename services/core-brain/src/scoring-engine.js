'use strict';

const { scoreEvent, shouldAlert } = require('./scoring');

class ScoringEngine {
  constructor(config) {
    this.config = config;
  }

  score(event, anomalies, correlations) {
    return scoreEvent(event, anomalies, correlations);
  }

  shouldAlert(score) {
    return shouldAlert(score, this.config);
  }
}

module.exports = {
  ScoringEngine,
};

