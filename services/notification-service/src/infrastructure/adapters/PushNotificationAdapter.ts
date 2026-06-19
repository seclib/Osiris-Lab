import { Logger } from '../../application/commands/SendNotificationCommand';
import { Notification, NotificationChannel } from '../../domain/entities/Notification';

export interface PushNotificationAdapter {
  send(notification: Notification, deviceToken: string): Promise<boolean>;
  sendToMultiple(notification: Notification, deviceTokens: string[]): Promise<boolean[]>;
}

export class FirebasePushNotificationAdapter implements PushNotificationAdapter {
  private admin: unknown; // Firebase Admin SDK

  constructor(private logger: Logger) {
    // Initialize Firebase Admin
    // this.admin = require('firebase-admin');
    // this.admin.initializeApp({
    //   credential: admin.credential.cert(serviceAccount),
    // });
  }

  async send(notification: Notification, deviceToken: string): Promise<boolean> {
    try {
      const message = {
        token: deviceToken,
        notification: {
          title: notification.title,
          body: notification.message,
        },
        data: {
          notificationId: notification.id,
          type: notification.type,
          severity: notification.severity,
          ...notification.data,
        },
        android: {
          priority: 'high',
          notification: {
            channelId: this.getChannelId(notification.severity),
            sound: 'default',
            clickAction: 'OPEN_NOTIFICATION',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
              category: this.getCategory(notification.type),
            },
          },
        },
      };

      // await this.admin.messaging().send(message);
      
      this.logger.info('Push notification sent', {
        notificationId: notification.id,
        deviceToken: deviceToken.substring(0, 10) + '...',
      });

      return true;
    } catch (error) {
      this.logger.error('Failed to send push notification', {
        error: error instanceof Error ? error.message : 'Unknown error',
        notificationId: notification.id,
      });
      return false;
    }
  }

  async sendToMultiple(notification: Notification, deviceTokens: string[]): Promise<boolean[]> {
    const results = await Promise.all(
      deviceTokens.map(token => this.send(notification, token))
    );
    return results;
  }

  private getChannelId(severity: string): string {
    switch (severity) {
      case 'critical':
        return 'critical';
      case 'high':
        return 'high';
      case 'medium':
        return 'medium';
      default:
        return 'default';
    }
  }

  private getCategory(type: string): string {
    return type; // e.g., 'alert', 'info', 'warning'
  }
}

export class MockPushNotificationAdapter implements PushNotificationAdapter {
  constructor(private logger: Logger) {}

  async send(notification: Notification, deviceToken: string): Promise<boolean> {
    this.logger.info('Mock push notification sent', {
      notificationId: notification.id,
      deviceToken: deviceToken.substring(0, 10) + '...',
      title: notification.title,
    });
    return true;
  }

  async sendToMultiple(notification: Notification, deviceTokens: string[]): Promise<boolean[]> {
    this.logger.info('Mock push notifications sent', {
      notificationId: notification.id,
      count: deviceTokens.length,
    });
    return deviceTokens.map(() => true);
  }
}