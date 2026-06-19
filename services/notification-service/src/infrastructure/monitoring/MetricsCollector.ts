import { Logger, Metrics } from '../../shared/interfaces';
import { MetricNames } from '../../shared/constants';

export interface NotificationMetrics {
  // Counters
  notificationsCreated: number;
  notificationsSent: number;
  notificationsDelivered: number;
  notificationsFailed: number;
  notificationsRead: number;
  validationFailures: number;
  
  // Histograms
  createDuration: number[];
  sendDuration: number[];
  deliveryDuration: number[];
  
  // Gauges
  activeWebSocketConnections: number;
  cacheHitRate: number;
  dbConnectionPoolUsage: number;
}

export class MetricsCollector implements Metrics {
  private metrics: NotificationMetrics;
  private logger: Logger;
  private startTime: Map<string, number>;

  constructor(logger: Logger) {
    this.logger = logger;
    this.metrics = {
      notificationsCreated: 0,
      notificationsSent: 0,
      notificationsDelivered: 0,
      notificationsFailed: 0,
      notificationsRead: 0,
      validationFailures: 0,
      createDuration: [],
      sendDuration: [],
      deliveryDuration: [],
      activeWebSocketConnections: 0,
      cacheHitRate: 0,
      dbConnectionPoolUsage: 0,
    };
    this.startTime = new Map();
  }

  increment(metric: string, tags?: Record<string, string>): void {
    switch (metric) {
      case MetricNames.NOTIFICATION_CREATED:
        this.metrics.notificationsCreated++;
        this.logger.debug('Metric incremented', { metric, value: this.metrics.notificationsCreated });
        break;
      case MetricNames.NOTIFICATION_VALIDATION_FAILED:
        this.metrics.validationFailures++;
        this.logger.debug('Metric incremented', { metric, value: this.metrics.validationFailures });
        break;
      case MetricNames.NOTIFICATION_CREATE_FAILED:
        this.metrics.notificationsFailed++;
        this.logger.debug('Metric incremented', { metric, value: this.metrics.notificationsFailed });
        break;
      default:
        this.logger.warn('Unknown metric', { metric });
    }
  }

  histogram(metric: string, value: number, tags?: Record<string, string>): void {
    switch (metric) {
      case MetricNames.NOTIFICATION_CREATE_DURATION_MS:
        this.metrics.createDuration.push(value);
        // Keep only last 1000 values
        if (this.metrics.createDuration.length > 1000) {
          this.metrics.createDuration.shift();
        }
        break;
      default:
        this.logger.warn('Unknown histogram metric', { metric });
    }
  }

  /**
   * Start timing an operation
   */
  startTimer(operation: string): void {
    this.startTime.set(operation, Date.now());
  }

  /**
   * End timing and record duration
   */
  endTimer(operation: string, metricName: string): void {
    const start = this.startTime.get(operation);
    if (start) {
      const duration = Date.now() - start;
      this.histogram(metricName, duration);
      this.startTime.delete(operation);
    }
  }

  /**
   * Update gauge metrics
   */
  updateGauge(name: string, value: number): void {
    switch (name) {
      case 'websocket.connections':
        this.metrics.activeWebSocketConnections = value;
        break;
      case 'cache.hit_rate':
        this.metrics.cacheHitRate = value;
        break;
      case 'db.pool.usage':
        this.metrics.dbConnectionPoolUsage = value;
        break;
    }
  }

  /**
   * Get all metrics for Prometheus export
   */
  getMetrics(): NotificationMetrics {
    return { ...this.metrics };
  }

  /**
   * Get metrics in Prometheus format
   */
  getPrometheusMetrics(): string {
    const lines: string[] = [];
    
    // Counters
    lines.push(`# TYPE notification_created_total counter`);
    lines.push(`notification_created_total ${this.metrics.notificationsCreated}`);
    
    lines.push(`# TYPE notification_failed_total counter`);
    lines.push(`notification_failed_total ${this.metrics.notificationsFailed}`);
    
    lines.push(`# TYPE notification_validation_failures_total counter`);
    lines.push(`notification_validation_failures_total ${this.metrics.validationFailures}`);
    
    // Histograms
    if (this.metrics.createDuration.length > 0) {
      const sorted = [...this.metrics.createDuration].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const p99 = sorted[Math.floor(sorted.length * 0.99)];
      
      lines.push(`# TYPE notification_create_duration_ms histogram`);
      lines.push(`notification_create_duration_ms_bucket{le="50"} ${sorted.filter(v => v <= 50).length}`);
      lines.push(`notification_create_duration_ms_bucket{le="100"} ${sorted.filter(v => v <= 100).length}`);
      lines.push(`notification_create_duration_ms_bucket{le="500"} ${sorted.filter(v => v <= 500).length}`);
      lines.push(`notification_create_duration_ms_bucket{le="1000"} ${sorted.filter(v => v <= 1000).length}`);
      lines.push(`notification_create_duration_ms_bucket{le="+Inf"} ${sorted.length}`);
      lines.push(`notification_create_duration_ms_sum ${sorted.reduce((a, b) => a + b, 0)}`);
      lines.push(`notification_create_duration_ms_count ${sorted.length}`);
    }
    
    // Gauges
    lines.push(`# TYPE notification_websocket_connections gauge`);
    lines.push(`notification_websocket_connections ${this.metrics.activeWebSocketConnections}`);
    
    lines.push(`# TYPE notification_cache_hit_rate gauge`);
    lines.push(`notification_cache_hit_rate ${this.metrics.cacheHitRate}`);
    
    lines.push(`# TYPE notification_db_pool_usage gauge`);
    lines.push(`notification_db_pool_usage ${this.metrics.dbConnectionPoolUsage}`);
    
    return lines.join('\n');
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.metrics = {
      notificationsCreated: 0,
      notificationsSent: 0,
      notificationsDelivered: 0,
      notificationsFailed: 0,
      notificationsRead: 0,
      validationFailures: 0,
      createDuration: [],
      sendDuration: [],
      deliveryDuration: [],
      activeWebSocketConnections: 0,
      cacheHitRate: 0,
      dbConnectionPoolUsage: 0,
    };
    this.startTime.clear();
  }
}