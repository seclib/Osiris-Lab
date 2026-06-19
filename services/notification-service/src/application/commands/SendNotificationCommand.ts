import { v4 as uuidv4 } from 'uuid';
import { Notification, NotificationChannel, NotificationSeverity, NotificationType } from '../../domain/entities/Notification';
import { INotificationRepository } from '../../domain/repositories/INotificationRepository';
import { NotificationDomainService } from '../../domain/services/NotificationDomainService';

// Local interfaces to avoid external dependencies
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface Metrics {
  increment(metric: string, tags?: Record<string, string>): void;
  histogram(metric: string, value: number, tags?: Record<string, string>): void;
}

export interface SendNotificationCommandInput {
  userId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  channels: NotificationChannel[];
  priority: number;
  correlationId?: string;
}

export interface SendNotificationCommandResult {
  success: boolean;
  notification?: Notification;
  error?: string;
}

export class SendNotificationCommand {
  constructor(
    private notificationRepository: INotificationRepository,
    private domainService: NotificationDomainService,
    private logger: Logger,
    private metrics: Metrics,
    private natsPublisher?: {
      publish: (subject: string, data: Buffer) => Promise<void>;
    }
  ) {}

  async execute(input: SendNotificationCommandInput): Promise<SendNotificationCommandResult> {
    const startTime = Date.now();
    this.logger.info('Executing SendNotificationCommand', {
      userId: input.userId,
      type: input.type,
      severity: input.severity,
    });

    try {
      // Create notification entity
      const notification = new Notification({
        userId: input.userId,
        type: input.type,
        severity: input.severity,
        title: input.title,
        message: input.message,
        data: input.data,
        channels: input.channels,
        priority: input.priority,
      });

      // Validate business rules
      const validation = this.domainService.validate(notification);
      if (!validation.valid) {
        this.logger.warn('Notification validation failed', { errors: validation.errors });
        this.metrics.increment('notification.validation_failed');
        return {
          success: false,
          error: `Validation failed: ${validation.errors.join(', ')}`,
        };
      }

      // Save to database
      const savedNotification = await this.notificationRepository.save(notification);

      // Publish notification.requested event
      if (this.natsPublisher) {
        await this.natsPublisher.publish('notification.requested', Buffer.from(JSON.stringify({
          id: uuidv4(),
          type: 'notification.requested',
          source: 'notification-service',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
          correlation_id: input.correlationId,
          payload: {
            notification_id: savedNotification.id,
            user_id: input.userId,
            type: input.type,
            severity: input.severity,
            title: input.title,
            message: input.message,
            data: input.data,
            channels: input.channels,
            priority: input.priority,
          },
          metadata: {
            user_id: input.userId,
          },
        })));
      }

      this.logger.info('Notification created successfully', {
        notificationId: savedNotification.id,
        userId: input.userId,
      });

      this.metrics.increment('notification.created', {
        type: input.type,
        severity: input.severity,
      });

      const duration = Date.now() - startTime;
      this.metrics.histogram('notification.create_duration_ms', duration);

      return {
        success: true,
        notification: savedNotification,
      };
    } catch (error) {
      this.logger.error('Failed to send notification', {
        error: error instanceof Error ? error.message : 'Unknown error',
        userId: input.userId,
      });

      this.metrics.increment('notification.create_failed');

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}