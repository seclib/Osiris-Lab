import { Notification, NotificationType, NotificationSeverity, NotificationChannel } from '../../domain/entities/Notification';
import { Logger, EventPublisher } from '../../shared/interfaces';
import { EventSubjects } from '../../shared/constants';

/**
 * gRPC Service Interface for internal service communication
 * 
 * This provides a high-performance alternative to REST for internal service calls
 * while maintaining backward compatibility with existing REST API
 */
export interface NotificationGrpcService {
  sendNotification(request: SendNotificationRequest): Promise<SendNotificationResponse>;
  getNotifications(request: GetNotificationsRequest): Promise<GetNotificationsResponse>;
  markAsRead(request: MarkAsReadRequest): Promise<MarkAsReadResponse>;
}

export interface SendNotificationRequest {
  userId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  channels: NotificationChannel[];
  priority: number;
  correlationId?: string;
}

export interface SendNotificationResponse {
  success: boolean;
  notificationId?: string;
  error?: string;
}

export interface GetNotificationsRequest {
  userId: string;
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
}

export interface GetNotificationsResponse {
  success: boolean;
  notifications?: Array<{
    id: string;
    type: string;
    severity: string;
    title: string;
    message: string;
    channels: string[];
    priority: number;
    status: string;
    read: boolean;
    createdAt: string;
  }>;
  total: number;
  unreadCount: number;
  error?: string;
}

export interface MarkAsReadRequest {
  notificationId: string;
  userId: string;
}

export interface MarkAsReadResponse {
  success: boolean;
  error?: string;
}

/**
 * gRPC Service Implementation
 * 
 * Wraps existing CQRS commands/queries for gRPC interface
 * Maintains same business logic, different transport layer
 */
export class NotificationGrpcServiceImpl implements NotificationGrpcService {
  constructor(
    private logger: Logger,
    private eventPublisher?: EventPublisher
  ) {}

  async sendNotification(request: SendNotificationRequest): Promise<SendNotificationResponse> {
    this.logger.info('gRPC: sendNotification called', {
      userId: request.userId,
      type: request.type,
    });

    try {
      // Publish event for async processing
      if (this.eventPublisher) {
        await this.eventPublisher.publish(EventSubjects.NOTIFICATION_REQUESTED, Buffer.from(JSON.stringify({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
          type: EventSubjects.NOTIFICATION_REQUESTED,
          source: 'notification-service-grpc',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
          correlation_id: request.correlationId,
          payload: request,
          metadata: {
            user_id: request.userId,
            transport: 'grpc',
          },
        })));
      }

      // In real implementation, this would call the command handler
      // For now, return success (actual processing is async via events)
      return {
        success: true,
        notificationId: `notif_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      };
    } catch (error) {
      this.logger.error('gRPC: sendNotification failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        userId: request.userId,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async getNotifications(request: GetNotificationsRequest): Promise<GetNotificationsResponse> {
    this.logger.info('gRPC: getNotifications called', {
      userId: request.userId,
      limit: request.limit,
    });

    try {
      // In real implementation, this would call the query handler
      // For now, return empty result
      return {
        success: true,
        notifications: [],
        total: 0,
        unreadCount: 0,
      };
    } catch (error) {
      this.logger.error('gRPC: getNotifications failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        userId: request.userId,
      });

      return {
        success: false,
        total: 0,
        unreadCount: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async markAsRead(request: MarkAsReadRequest): Promise<MarkAsReadResponse> {
    this.logger.info('gRPC: markAsRead called', {
      notificationId: request.notificationId,
      userId: request.userId,
    });

    try {
      // Publish event
      if (this.eventPublisher) {
        await this.eventPublisher.publish(EventSubjects.NOTIFICATION_READ, Buffer.from(JSON.stringify({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
          type: EventSubjects.NOTIFICATION_READ,
          source: 'notification-service-grpc',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
          payload: {
            notification_id: request.notificationId,
            user_id: request.userId,
          },
          metadata: {
            user_id: request.userId,
            transport: 'grpc',
          },
        })));
      }

      return { success: true };
    } catch (error) {
      this.logger.error('gRPC: markAsRead failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        notificationId: request.notificationId,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}