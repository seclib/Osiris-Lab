import { Logger } from '../../shared/interfaces';

export enum CircuitBreakerState {
  CLOSED = 'CLOSED',     // Normal operation
  OPEN = 'OPEN',         // Failing, reject requests
  HALF_OPEN = 'HALF_OPEN', // Testing if service recovered
}

export interface CircuitBreakerConfig {
  failureThreshold: number;      // Number of failures before opening
  successThreshold: number;      // Number of successes in half-open before closing
  timeout: number;               // Time in ms before attempting half-open
  monitoringPeriod: number;      // Time window for failure counting
}

export interface CircuitBreakerMetrics {
  failures: number;
  successes: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastFailureTime?: Date;
  lastSuccessTime?: Date;
  state: CircuitBreakerState;
}

/**
 * Circuit Breaker Pattern Implementation
 * 
 * Prevents cascading failures by failing fast when external service is down
 */
export class CircuitBreaker {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private failures: number = 0;
  private successes: number = 0;
  private consecutiveFailures: number = 0;
  private consecutiveSuccesses: number = 0;
  private lastFailureTime?: Date;
  private lastSuccessTime?: Date;
  private failureTimestamps: Date[] = [];

  private config: Required<CircuitBreakerConfig>;
  private logger: Logger;
  private name: string;

  constructor(
    name: string,
    config: Partial<CircuitBreakerConfig> = {},
    logger: Logger
  ) {
    this.name = name;
    this.logger = logger;
    this.config = {
      failureThreshold: config.failureThreshold || 5,
      successThreshold: config.successThreshold || 2,
      timeout: config.timeout || 60000, // 60 seconds
      monitoringPeriod: config.monitoringPeriod || 120000, // 2 minutes
    };
  }

  /**
   * Execute function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>, fallback?: () => Promise<T>): Promise<T> {
    if (this.state === CircuitBreakerState.OPEN) {
      // Check if timeout has elapsed
      if (this.lastFailureTime && this.isTimeoutElapsed()) {
        this.logger.info('Circuit breaker transitioning to HALF_OPEN', {
          circuit: this.name,
        });
        this.state = CircuitBreakerState.HALF_OPEN;
      } else {
        // Circuit is open, reject or use fallback
        this.logger.warn('Circuit breaker is OPEN, rejecting request', {
          circuit: this.name,
        });

        if (fallback) {
          return fallback();
        }

        throw new Error(`Circuit breaker ${this.name} is OPEN`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Record successful call
   */
  private onSuccess(): void {
    this.successes++;
    this.consecutiveSuccesses++;
    this.consecutiveFailures = 0;
    this.lastSuccessTime = new Date();

    this.logger.debug('Circuit breaker success', {
      circuit: this.name,
      state: this.state,
      consecutiveSuccesses: this.consecutiveSuccesses,
    });

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        this.logger.info('Circuit breaker transitioning to CLOSED', {
          circuit: this.name,
        });
        this.state = CircuitBreakerState.CLOSED;
        this.failures = 0;
        this.failureTimestamps = [];
      }
    }
  }

  /**
   * Record failed call
   */
  private onFailure(): void {
    this.failures++;
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;
    this.lastFailureTime = new Date();
    this.failureTimestamps.push(new Date());

    // Clean old failures outside monitoring period
    this.cleanOldFailures();

    this.logger.warn('Circuit breaker failure', {
      circuit: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      failures: this.failures,
    });

    if (this.state === CircuitBreakerState.CLOSED) {
      if (this.consecutiveFailures >= this.config.failureThreshold) {
        this.logger.error('Circuit breaker transitioning to OPEN', {
          circuit: this.name,
          consecutiveFailures: this.consecutiveFailures,
        });
        this.state = CircuitBreakerState.OPEN;
      }
    } else if (this.state === CircuitBreakerState.HALF_OPEN) {
      // Any failure in half-open goes back to open
      this.logger.warn('Circuit breaker back to OPEN', {
        circuit: this.name,
      });
      this.state = CircuitBreakerState.OPEN;
    }
  }

  /**
   * Check if timeout has elapsed since last failure
   */
  private isTimeoutElapsed(): boolean {
    if (!this.lastFailureTime) return false;
    const elapsed = Date.now() - this.lastFailureTime.getTime();
    return elapsed >= this.config.timeout;
  }

  /**
   * Remove failures outside monitoring period
   */
  private cleanOldFailures(): void {
    const cutoff = new Date(Date.now() - this.config.monitoringPeriod);
    this.failureTimestamps = this.failureTimestamps.filter(
      timestamp => timestamp > cutoff
    );
  }

  /**
   * Get current circuit breaker state
   */
  getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * Get circuit breaker metrics
   */
  getMetrics(): CircuitBreakerMetrics {
    return {
      failures: this.failures,
      successes: this.successes,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      state: this.state,
    };
  }

  /**
   * Manually reset circuit breaker
   */
  reset(): void {
    this.logger.info('Circuit breaker manually reset', {
      circuit: this.name,
    });
    this.state = CircuitBreakerState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.failureTimestamps = [];
  }

  /**
   * Check if circuit is healthy
   */
  isHealthy(): boolean {
    return this.state !== CircuitBreakerState.OPEN;
  }
}

/**
 * Circuit Breaker Factory
 * Creates circuit breakers for different external services
 */
export class CircuitBreakerFactory {
  private breakers: Map<string, CircuitBreaker> = new Map();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Get or create circuit breaker for a service
   */
  getBreaker(name: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    if (!this.breakers.has(name)) {
      const breaker = new CircuitBreaker(name, config, this.logger);
      this.breakers.set(name, breaker);
      this.logger.info('Circuit breaker created', { circuit: name });
    }
    return this.breakers.get(name)!;
  }

  /**
   * Get all circuit breakers
   */
  getAllBreakers(): Map<string, CircuitBreaker> {
    return new Map(this.breakers);
  }

  /**
   * Get metrics for all circuit breakers
   */
  getAllMetrics(): Record<string, CircuitBreakerMetrics> {
    const metrics: Record<string, CircuitBreakerMetrics> = {};
    this.breakers.forEach((breaker, name) => {
      metrics[name] = breaker.getMetrics();
    });
    return metrics;
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    this.breakers.forEach(breaker => breaker.reset());
  }
}