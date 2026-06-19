import express from 'express';
import { Pool } from 'pg';
import { SocketIOGatewayImpl } from './infrastructure/websocket/SocketIOGateway';
import { PostgresNotificationRepository } from './infrastructure/database/PostgresNotificationRepository';
import { NotificationEventPublisher } from './infrastructure/nats/NotificationEventPublisher';
import { SendNotificationCommand } from './application/commands/SendNotificationCommand';
import { MarkNotificationReadCommand } from './application/commands/MarkNotificationReadCommand';
import { GetNotificationsQuery } from './application/queries/GetNotificationsQuery';
import { NotificationDomainService } from './domain/services/NotificationDomainService';
import { createNotificationRouter } from './presentation/routes/notification.routes';
import { Logger, Metrics } from './application/commands/SendNotificationCommand';

async function main(): Promise<void> {
  // Configuration
  const port = parseInt(process.env.PORT || '4000', 10);
  const dbUrl = process.env.DATABASE_URL || 'postgresql://osiris:osiris@localhost:5432/osiris';
  const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';

  // Initialize logger and metrics
  const logger: Logger = {
    info: (message: string, context?: Record<string, unknown>) => console.log(`[INFO] ${message}`, context),
    warn: (message: string, context?: Record<string, unknown>) => console.warn(`[WARN] ${message}`, context),
    error: (message: string, context?: Record<string, unknown>) => console.error(`[ERROR] ${message}`, context),
  };

  const metrics: Metrics = {
    increment: (metric: string, tags?: Record<string, string>) => console.log(`[METRIC] ${metric}`, tags),
    histogram: (metric: string, value: number, tags?: Record<string, string>) => console.log(`[METRIC] ${metric}: ${value}`, tags),
  };

  // Connect to PostgreSQL
  const pool = new Pool({ connectionString: dbUrl });
  const db = { query: (text: string, params?: unknown[]) => pool.query(text, params) };

  // Initialize repositories
  const notificationRepository = new PostgresNotificationRepository(db);

  // Initialize domain service
  const domainService = new NotificationDomainService();

  // Initialize NATS publisher (mock for now)
  const natsPublisher = {
    publish: async (subject: string, data: Buffer) => {
      logger.info('NATS publish', { subject, data: data.toString() });
    },
  };

  // Initialize event publisher
  const eventPublisher = new NotificationEventPublisher(natsPublisher, logger);

  // Initialize commands
  const sendNotificationCommand = new SendNotificationCommand(
    notificationRepository,
    domainService,
    logger,
    metrics,
    natsPublisher
  );

  const markNotificationReadCommand = new MarkNotificationReadCommand(
    notificationRepository,
    logger
  );

  const getNotificationsQuery = new GetNotificationsQuery(
    notificationRepository,
    logger
  );

  // Initialize WebSocket gateway
  const socketIOGateway = new SocketIOGatewayImpl(logger);
  socketIOGateway.initialize();

  // Create Express app
  const app = express();
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      service: 'notification-service',
      timestamp: new Date().toISOString(),
      connectedUsers: socketIOGateway.getConnectedUsers().length,
    });
  });

  // Notification routes
  app.use('/notifications', createNotificationRouter({
    sendNotificationCommand,
    markNotificationReadCommand,
    getNotificationsQuery,
    logger,
  }));

  // Start server
  app.listen(port, () => {
    logger.info('Notification Service started', { port, dbUrl, natsUrl });
    console.log(`Notification Service running on port ${port}`);
    console.log(`WebSocket Gateway running on port ${process.env.WEBSOCKET_PORT || '4001'}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('Shutting down notification service');
    socketIOGateway.disconnect();
    await pool.end();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Failed to start notification service:', error);
  process.exit(1);
});