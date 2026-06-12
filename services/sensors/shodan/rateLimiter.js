'use strict';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RateLimiter {
  constructor(options = {}) {
    this.minIntervalMs = Math.max(0, Number(options.minIntervalMs || 0));
    this.nextAllowedAt = 0;
    this.queue = Promise.resolve();
    this.stats = {
      queued: 0,
      completed: 0,
      waitedMs: 0,
      lastWaitMs: 0,
      lastRunAt: null,
    };
  }

  async waitForTurn() {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAllowedAt - now);
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.minIntervalMs;

    this.stats.lastWaitMs = waitMs;
    this.stats.waitedMs += waitMs;
    if (waitMs > 0) await sleep(waitMs);
    this.stats.lastRunAt = new Date().toISOString();
  }

  schedule(task) {
    if (typeof task !== 'function') throw new TypeError('rate_limiter_task_required');

    this.stats.queued += 1;
    const run = async () => {
      await this.waitForTurn();
      try {
        return await task();
      } finally {
        this.stats.completed += 1;
      }
    };

    const pending = this.queue.then(run, run);
    this.queue = pending.catch(() => {});
    return pending;
  }

  health() {
    return {
      minIntervalMs: this.minIntervalMs,
      ...this.stats,
    };
  }
}

module.exports = {
  RateLimiter,
  sleep,
};
