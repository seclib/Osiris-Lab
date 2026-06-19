import { Logger } from '../../application/commands/SendNotificationCommand';

export interface NATSMessage {
  publish: (subject: string, data: Buffer) => Promise<void>;
}

export class NotificationEventPublisher {
  constructor(private nats: NATSMessage, private logger: Logger) {}

  async publishNotificationSent(data: {
    notificationId: string;
    userId: string;
    channel: string;
    status: 'sent' | 'delivered' | 'failed';
    error?: string;
  }): Promise<void> {
    try {
      await this.nats.publish('notification.sent', Buffer.from(JSON.stringify({
        id: this.generateEventId(),
        type: 'notification.sent',
        source: 'notification-service',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        payload: {
          notification_id: data.notificationId,
          user_id: data.userId,
          channel: data.channel,
          status: data.status,
          timestamp: new Date().toISOString(),
          error: data.error,
        },
        metadata: {
          user_id: data.userId,
        },
      })));

      this.logger.info('Published notification.sent event', {
        notificationId: data.notificationId,
        channel: data.channel,
        status: data.status,
      });
    } catch (error) {
      this.logger.error('Failed to publish notification.sent event', {
        error: error instanceof Error ? error.message : 'Unknown error',
        notificationId: data.notificationId,
      });
      throw error;
    }
  }

  async publishNotificationDelivered(data: {
    notificationId: string;
    userId: string;
    channel: string;
  }): Promise<void> {
    try {
      await this.nats.publish('notification.delivered', Buffer.from(JSON.stringify({
        id: this.generateEventId(),
        type: 'notification.delivered',
        source: 'notification-service',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        payload: {
          notification_id: data.notificationId,
          user_id: data.userId,
          channel: data.channel,
          delivered_at: new Date().toISOString(),
        },
        metadata: {
          user_id: data.userId,
        },
      })));

      this.logger.info('Published notification.delivered event', {
        notificationId: data.notificationId,
        channel: data.channel,
      });
    } catch (error) {
      this.logger.error('Failed to publish notification.delivered event', {
        error: error instanceof Error ? error.message : 'Unknown error',
        notificationId: data.notificationId,
      });
      throw error;
    }
  }

  async publishNotificationFailed(data: {
    notificationId: string;
    userId: string;
    channel: string;
    error: string;
  }): Promise<void> {
    try {
      await this.nats.publish('notification.failed', Buffer.from(JSON.stringify({
        id: this.generateEventId(),
        type: 'notification.failed',
        source: 'notification-service',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        payload: {
          notification_id: data.notificationId,
          user_id: data.userId,
          channel: data.channel,
          error: data.error,
          failed_at: new Date().toISOString(),
        },
        metadata: {
          user_id: data.userId,
        },
      })));

      this.logger.error('Published notification.failed event', {
        notificationId: data.notificationId,
        channel: data.channel,
        error: data.error,
      });
    } catch (error) {
      this.logger.error('Failed to publish notification.failed event', {
        error: error instanceof Error ? error.message : 'Unknown error',
        notificationId: data.notificationId,
      });
      throw error;
    }
  }

  async publishNotificationRead(data: {
    notificationId: string;
    userId: string;
  }): Promise<void> {
    try {
      await this.nats.publish('notification.read', Buffer.from(JSON.stringify({
        id: this.generateEventId(),
        type: 'notification.read',
        source: 'notification-service',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        payload: {
          notification_id: data.notificationId,
          user_id: data.userId,
          read_at: new Date().toISOString(),
        },
        metadata: {
          user_id: data.userId,
        },
      })));

      this.logger.info('Published notification.read event', {
        notificationId: data.notificationId,
      });
    } catch (error) {
      this.logger.error('Failed to publish notification.read event', {
        error: error instanceof Error ? error.message : 'Unknown error',
        notificationId: data.notificationId,
      });
      throw error;
    }
  }

  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}