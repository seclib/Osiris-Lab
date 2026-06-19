import { Notification, NotificationChannel, NotificationSeverity, NotificationType } from '../../domain/entities/Notification';
import { INotificationRepository } from '../../domain/repositories/INotificationRepository';
import { NotificationDomainService } from '../../domain/services/NotificationDomainService';
import { NotificationValidator } from '../../domain/validators/NotificationValidator';
import { Logger, Metrics, EventPublisher } from '../../shared/interfaces';
import { EventSubjects, MetricNames } from '../../shared/constants';
import { generateId } from '../../shared/utils';

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
    private natsPublisher?: EventPublisher
  ) {}

  async execute(input: SendNotificationCommandInput): Promise<SendNotificationCommandResult> {
    const startTime = Date.now();
    this.logger.info('Executing SendNotificationCommand', {
      userId: input.userId,
      type: input.type,
      severity: input.severity,
    });

    try {
      // Validate input (CRITICAL: prevent invalid data)
      try {
        NotificationValidator.validateNotificationInput(input);
      } catch (validationError) {
        this.logger.warn('Input validation failed', {
          error: validationError instanceof Error ? validationError.message : 'Unknown error',
          userId: input.userId,
        });
        this.metrics.increment(MetricNames.NOTIFICATION_VALIDATION_FAILED);
        return {
          success: false,
          error: validationError instanceof Error ? validationError.message : 'Validation failed',
        };
      }

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
        this.metrics.increment(MetricNames.NOTIFICATION_VALIDATION_FAILED);
        return {
          success: false,
          error: `Validation failed: ${validation.errors.join(', ')}`,
        };
      }

      // Save to database
      const savedNotification = await this.notificationRepository.save(notification);

      // Publish notification.requested event
      if (this.natsPublisher) {
        await this.natsPublisher.publish(EventSubjects.NOTIFICATION_REQUESTED, Buffer.from(JSON.stringify({
          id: generateId('evt_'),
          type: EventSubjects.NOTIFICATION_REQUESTED,
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

        this.metrics.increment(MetricNames.NOTIFICATION_CREATED, {
        type: input.type,
        severity: input.severity,
      });

      const duration = Date.now() - startTime;
      this.metrics.histogram(MetricNames.NOTIFICATION_CREATE_DURATION_MS, duration);

      return {
        success: true,
        notification: savedNotification,
      };
    } catch (error) {
      this.logger.error('Failed to send notification', {
        error: error instanceof Error ? error.message : 'Unknown error',
        userId: input.userId,
      });

      this.metrics.increment(MetricNames.NOTIFICATION_CREATE_FAILED);

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}