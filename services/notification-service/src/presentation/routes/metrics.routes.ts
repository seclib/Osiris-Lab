import { Router, Request, Response } from 'express';
import { MetricsCollector } from '../../infrastructure/monitoring/MetricsCollector';
import { Logger } from '../../shared/interfaces';

export function createMetricsRouter(metricsCollector: MetricsCollector, logger: Logger): Router {
  const router = Router();

  /**
   * GET /metrics
   * Prometheus metrics endpoint
   */
  router.get('/metrics', async (req: Request, res: Response): Promise<void> => {
    try {
      const metrics = metricsCollector.getPrometheusMetrics();
      
      res.setHeader('Content-Type', 'text/plain; version=0.0.4');
      res.send(metrics);
      
      logger.debug('Metrics endpoint called');
    } catch (error) {
      logger.error('Failed to generate metrics', { error });
      res.status(500).json({
        error: 'Failed to generate metrics',
      });
    }
  });

  /**
   * GET /metrics/json
   * JSON metrics endpoint for debugging
   */
  router.get('/metrics/json', async (req: Request, res: Response): Promise<void> => {
    try {
      const metrics = metricsCollector.getMetrics();
      
      res.json({
        success: true,
        data: metrics,
        timestamp: new Date().toISOString(),
      });
      
      logger.debug('Metrics JSON endpoint called');
    } catch (error) {
      logger.error('Failed to get metrics', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to get metrics',
      });
    }
  });

  /**
   * GET /health
   * Health check endpoint
   */
  router.get('/health', async (req: Request, res: Response): Promise<void> => {
    try {
      res.json({
        status: 'healthy',
        service: 'notification-service',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Health check failed', { error });
      res.status(500).json({
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /ready
   * Readiness check endpoint
   */
  router.get('/ready', async (req: Request, res: Response): Promise<void> => {
    try {
      // Check dependencies (DB, Redis, NATS)
      const checks = {
        database: true, // Would check DB connection
        redis: true,    // Would check Redis connection
        nats: true,     // Would check NATS connection
      };

      const isReady = Object.values(checks).every(v => v === true);

      if (isReady) {
        res.json({
          ready: true,
          checks,
          timestamp: new Date().toISOString(),
        });
      } else {
        res.status(503).json({
          ready: false,
          checks,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      logger.error('Readiness check failed', { error });
      res.status(503).json({
        ready: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}