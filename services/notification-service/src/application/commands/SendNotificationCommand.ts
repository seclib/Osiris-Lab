import { Notification, NotificationChannel, NotificationSeverity, NotificationType } from '../../domain/entities/Notification';
import { INotificationRepository } from '../../domain/repositories/INotificationRepository';
import { NotificationDomainService } from '../../domain/services/NotificationDomainService';
import { NotificationValidator } from '../../domain/validators/NotificationValidator';
import { Logger, Metrics, EventPublisher } from '../../shared/interfaces';
import { EventSubjects, MetricNames } from '../../shared/constants';
import { generateId, getCorrelationId } from '../../shared/utils';

/**
 * Input for sending a notification
 * @property userId - Recipient user ID (UUID v4)
 * @property type - Notification type
 * @property severity - Notification severity level
 * @property title - Notification title (max 255 chars)
 * @property message - Notification message (max 5000 chars)
 * @property data - Additional data (optional)
 * @property channels - Delivery channels (websocket, push, email)
 * @property priority - Priority level (1-10, higher = more important)
 * @property correlationId - Correlation ID for tracing (optional)
 */
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

/**
 * Result of sending a notification
 * @property success - Whether the operation succeeded
 * @property notification - Created notification entity (if success)
 * @property error - Error message (if failed)
 */
export interface SendNotificationCommandResult {
  success: boolean;
  notification?: Notification;
  error?: string;
}

/**
 * Command to send a notification
 * 
 * Responsibilities:
 * 1. Validate input (NotificationValidator)
 * 2. Create notification entity
 * 3. Validate business rules (NotificationDomainService)
 * 4. Persist to database (INotificationRepository)
 * 5. Publish event (EventPublisher)
 * 6. Record metrics (Metrics)
 * 
 * @see NotificationValidator
 * @see NotificationDomainService
 * @see INotificationRepository
 * @see EventPublisher
 */
export class SendNotificationCommand {
  private readonly correlationId: string;

  constructor(
    private readonly notificationRepository: INotificationRepository,
    private readonly domainService: NotificationDomainService,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly natsPublisher?: EventPublisher,
    correlationId?: string
  ) {
    this.correlationId = correlationId || getCorrelationId();
  }

  /**
   * Execute the command to send a notification
   * @param input - Command input
   * @returns Promise<SendNotificationCommandResult>
   * @throws Never throws - all errors are caught and returned in result
   */
  async execute(input: SendNotificationCommandInput): Promise<SendNotificationCommandResult> {
    const startTime = Date.now();
    const operationId = generateId('op_');

    this.logger.info('Executing SendNotificationCommand', {
      operationId,
      userId: input.userId,
      type: input.type,
      severity: input.severity,
      channels: input.channels,
      correlationId: this.correlationId,
    });

    try {
      // Step 1: Validate input
      const validationResult = this.validateInput(input);
      if (!validationResult.valid) {
        return validationResult.error!;
      }

      // Step 2: Create notification entity
      const notification = this.createNotification(input);

      // Step 3: Validate business rules
      const businessValidation = this.validateBusinessRules(notification);
      if (!businessValidation.valid) {
        return businessValidation.error!;
      }

      // Step 4: Persist to database
      const savedNotification = await this.persistNotification(notification);

      // Step 5: Publish event (async, don't block)
      this.publishEventAsync(input, savedNotification);

      // Step 6: Record success metrics
      this.recordSuccessMetrics(input, startTime);

      this.logger.info('Notification created successfully', {
        operationId,
        notificationId: savedNotification.id,
        userId: input.userId,
        durationMs: Date.now() - startTime,
      });

      return {
        success: true,
        notification: savedNotification,
      };
    } catch (error) {
      return this.handleError(error, input, startTime);
    }
  }

  /**
   * Validate command input
   * @private
   */
  private validateInput(input: SendNotificationCommandInput): { valid: boolean; error?: SendNotificationCommandResult } {
    try {
      NotificationValidator.validateNotificationInput(input);
      return { valid: true };
    } catch (validationError) {
      const errorMessage = validationError instanceof Error ? validationError.message : 'Validation failed';
      
      this.logger.warn('Input validation failed', {
        operationId: this.correlationId,
        userId: input.userId,
        error: errorMessage,
      });

      this.metrics.increment(MetricNames.NOTIFICATION_VALIDATION_FAILED, {
        type: input.type,
        severity: input.severity,
      });

      return {
        valid: false,
        error: {
          success: false,
          error: errorMessage,
        },
      };
    }
  }

  /**
   * Create notification entity from input
   * @private
   */
  private createNotification(input: SendNotificationCommandInput): Notification {
    return new Notification({
      userId: input.userId,
      type: input.type,
      severity: input.severity,
      title: input.title,
      message: input.message,
      data: input.data,
      channels: input.channels,
      priority: input.priority,
    });
  }

  /**
   * Validate business rules
   * @private
   */
  private validateBusinessRules(notification: Notification): { valid: boolean; error?: SendNotificationCommandResult } {
    const validation = this.domainService.validate(notification);
    
    if (!validation.valid) {
      const errorMessage = `Business validation failed: ${validation.errors.join(', ')}`;
      
      this.logger.warn('Business validation failed', {
        correlationId: this.correlationId,
        notificationId: notification.id,
        errors: validation.errors,
      });

      this.metrics.increment(MetricNames.NOTIFICATION_VALIDATION_FAILED);

      return {
        valid: false,
        error: {
          success: false,
          error: errorMessage,
        },
      };
    }

    return { valid: true };
  }

  /**
   * Persist notification to database
   * @private
   */
  private async persistNotification(notification: Notification): Promise<Notification> {
    try {
      return await this.notificationRepository.save(notification);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Database error';
      
      this.logger.error('Failed to persist notification', {
        correlationId: this.correlationId,
        notificationId: notification.id,
        error: errorMessage,
      });

      this.metrics.increment(MetricNames.NOTIFICATION_CREATE_FAILED);
      throw error;
    }
  }

  /**
   * Publish event asynchronously (fire-and-forget)
   * @private
   */
  private publishEventAsync(input: SendNotificationCommandInput, savedNotification: Notification): void {
    if (!this.natsPublisher) {
      return;
    }

    const eventPayload = {
      id: generateId('evt_'),
      type: EventSubjects.NOTIFICATION_REQUESTED,
      source: 'notification-service',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      correlation_id: input.correlationId || this.correlationId,
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
        operation_id: this.correlationId,
      },
    };

    // Fire-and-forget: don't await, log errors separately
    this.natsPublisher.publish(EventSubjects.NOTIFICATION_REQUESTED, Buffer.from(JSON.stringify(eventPayload)))
      .catch((error) => {
        this.logger.error('Failed to publish notification.requested event', {
          correlationId: this.correlationId,
          notificationId: savedNotification.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        this.metrics.increment(MetricNames.NOTIFICATION_EVENT_PUBLISH_FAILED);
      });
  }

  /**
   * Record success metrics
   * @private
   */
  private recordSuccessMetrics(input: SendNotificationCommandInput, startTime: number): void {
    const duration = Date.now() - startTime;

    this.metrics.increment(MetricNames.NOTIFICATION_CREATED, {
      type: input.type,
      severity: input.severity,
    });

    this.metrics.histogram(MetricNames.NOTIFICATION_CREATE_DURATION_MS, duration);
  }

  /**
   * Handle errors
   * @private
   */
  private handleError(
    error: unknown,
    input: SendNotificationCommandInput,
    startTime: number
  ): SendNotificationCommandResult {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const duration = Date.now() - startTime;

    this.logger.error('Failed to send notification', {
      correlationId: this.correlationId,
      userId: input.userId,
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      durationMs: duration,
    });

    this.metrics.increment(MetricNames.NOTIFICATION_CREATE_FAILED);
    this.metrics.histogram(MetricNames.NOTIFICATION_CREATE_DURATION_MS, duration);

    return {
      success: false,
      error: errorMessage,
    };
  }
}