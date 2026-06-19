import { Notification, NotificationType, NotificationSeverity, NotificationChannel, NotificationStatus } from '../../../src/domain/entities/Notification';

describe('Notification Entity', () => {
  describe('constructor', () => {
    it('should create a notification with default values', () => {
      const notification = new Notification({
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.HIGH,
        title: 'Test Alert',
        message: 'Test message',
        channels: [NotificationChannel.WEBSOCKET],
        priority: 0,
      });

      expect(notification.userId).toBe('user_123');
      expect(notification.type).toBe(NotificationType.ALERT);
      expect(notification.severity).toBe(NotificationSeverity.HIGH);
      expect(notification.title).toBe('Test Alert');
      expect(notification.message).toBe('Test message');
      expect(notification.channels).toEqual([NotificationChannel.WEBSOCKET]);
      expect(notification.priority).toBe(0);
      expect(notification.status).toBe(NotificationStatus.PENDING);
      expect(notification.read).toBe(false);
      expect(notification.id).toBeDefined();
      expect(notification.createdAt).toBeInstanceOf(Date);
      expect(notification.updatedAt).toBeInstanceOf(Date);
    });

    it('should create a notification with custom values', () => {
      const now = new Date();
      const notification = new Notification({
        id: 'notif_123',
        userId: 'user_456',
        type: NotificationType.INFO,
        severity: NotificationSeverity.LOW,
        title: 'Info',
        message: 'Info message',
        channels: [NotificationChannel.EMAIL, NotificationChannel.PUSH],
        priority: 3,
        status: NotificationStatus.SENT,
        read: true,
        readAt: now,
        createdAt: now,
        updatedAt: now,
      });

      expect(notification.id).toBe('notif_123');
      expect(notification.priority).toBe(3);
      expect(notification.status).toBe(NotificationStatus.SENT);
      expect(notification.read).toBe(true);
      expect(notification.readAt).toBe(now);
    });

    it('should create a notification with data', () => {
      const notification = new Notification({
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.CRITICAL,
        title: 'Critical Alert',
        message: 'Critical message',
        channels: [NotificationChannel.WEBSOCKET],
        priority: 0,
        data: {
          alertId: 'alert_123',
          iocId: 'ioc_456',
        },
      });

      expect(notification.data).toEqual({
        alertId: 'alert_123',
        iocId: 'ioc_456',
      });
    });
  });

  describe('markAsRead', () => {
    it('should mark notification as read', () => {
      const notification = new Notification({
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.HIGH,
        title: 'Test',
        message: 'Test',
        channels: [NotificationChannel.WEBSOCKET],
        priority: 0,
      });

      expect(notification.read).toBe(false);
      expect(notification.readAt).toBeUndefined();

      notification.markAsRead();

      expect(notification.read).toBe(true);
      expect(notification.readAt).toBeInstanceOf(Date);
      expect(notification.status).toBe(NotificationStatus.READ);
    });

    it('should not change readAt if already read', () => {
      const now = new Date();
      const notification = new Notification({
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.HIGH,
        title: 'Test',
        message: 'Test',
        channels: [NotificationChannel.WEBSOCKET],
        priority: 0,
        read: true,
        readAt: now,
      });

      notification.markAsRead();

      expect(notification.readAt).toBe(now);
    });
  });

  describe('toJSON', () => {
    it('should serialize notification to JSON', () => {
      const notification = new Notification({
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.HIGH,
        title: 'Test Alert',
        message: 'Test message',
        channels: [NotificationChannel.WEBSOCKET, NotificationChannel.EMAIL],
        priority: 0,
        data: { key: 'value' },
      });

      const json = notification.toJSON();

      expect(json.userId).toBe('user_123');
      expect(json.type).toBe(NotificationType.ALERT);
      expect(json.severity).toBe(NotificationSeverity.HIGH);
      expect(json.title).toBe('Test Alert');
      expect(json.message).toBe('Test message');
      expect(json.channels).toEqual([NotificationChannel.WEBSOCKET, NotificationChannel.EMAIL]);
      expect(json.data).toEqual({ key: 'value' });
      expect(json.id).toBeDefined();
      expect(json.createdAt).toBeInstanceOf(Date);
      expect(json.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('business logic', () => {
    it('should identify critical notifications', () => {
      const criticalNotification = new Notification({
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.CRITICAL,
        title: 'Critical',
        message: 'Critical message',
        channels: [NotificationChannel.WEBSOCKET],
        priority: 5,
      });

      expect(criticalNotification.isCritical()).toBe(true);

      const highNotification = new Notification({
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.HIGH,
        title: 'High',
        message: 'High message',
        channels: [NotificationChannel.WEBSOCKET],
        priority: 4,
      });

      expect(highNotification.isCritical()).toBe(false);
    });

    it('should check channel presence', () => {
      const notification = new Notification({
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.HIGH,
        title: 'Test',
        message: 'Test',
        channels: [NotificationChannel.WEBSOCKET, NotificationChannel.EMAIL],
        priority: 0,
      });

      expect(notification.hasChannel(NotificationChannel.WEBSOCKET)).toBe(true);
      expect(notification.hasChannel(NotificationChannel.EMAIL)).toBe(true);
      expect(notification.hasChannel(NotificationChannel.PUSH)).toBe(false);
    });

    it('should transition through statuses', () => {
      const notification = new Notification({
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.HIGH,
        title: 'Test',
        message: 'Test',
        channels: [NotificationChannel.WEBSOCKET],
        priority: 0,
      });

      expect(notification.status).toBe(NotificationStatus.PENDING);

      notification.markAsSent();
      expect(notification.status).toBe(NotificationStatus.SENT);

      notification.markAsDelivered();
      expect(notification.status).toBe(NotificationStatus.DELIVERED);
    });

    it('should handle failures', () => {
      const notification = new Notification({
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.HIGH,
        title: 'Test',
        message: 'Test',
        channels: [NotificationChannel.WEBSOCKET],
        priority: 0,
      });

      notification.markAsFailed('Connection timeout');
      expect(notification.status).toBe(NotificationStatus.FAILED);
      expect(notification.data.error).toBe('Connection timeout');
    });
  });
});