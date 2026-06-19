import { Notification, NotificationType, NotificationSeverity, NotificationChannel, NotificationStatus } from '../../src/domain/entities/Notification';
import { NotificationValidator } from '../../src/domain/validators/NotificationValidator';
import { SendNotificationCommand } from '../../src/application/commands/SendNotificationCommand';
import { MarkNotificationReadCommand } from '../../src/application/commands/MarkNotificationReadCommand';
import { GetNotificationsQuery } from '../../src/application/queries/GetNotificationsQuery';

// Mock dependencies
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const mockMetrics = {
  increment: jest.fn(),
  histogram: jest.fn(),
};

const mockRepository = {
  save: jest.fn(),
  findById: jest.fn(),
  findByUserId: jest.fn(),
  findUnreadByUserId: jest.fn(),
  countUnreadByUserId: jest.fn(),
  markAsRead: jest.fn(),
  markAllAsRead: jest.fn(),
  delete: jest.fn(),
};

const mockNatsPublisher = {
  publish: jest.fn(),
};

describe('Notification Service Integration Tests', () => {
  describe('SendNotificationCommand', () => {
    let command: SendNotificationCommand;

    beforeEach(() => {
      jest.clearAllMocks();
      command = new SendNotificationCommand(
        mockRepository as any,
        {} as any,
        mockLogger,
        mockMetrics,
        mockNatsPublisher as any
      );
    });

    it('should send notification successfully', async () => {
      const input = {
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.HIGH,
        title: 'Test Alert',
        message: 'Test message',
        channels: [NotificationChannel.WEBSOCKET],
        priority: 0,
      };

      const mockNotification = new Notification(input);
      mockRepository.save.mockResolvedValue(mockNotification);

      const result = await command.execute(input);

      expect(result.success).toBe(true);
      expect(result.notification).toBeDefined();
      expect(mockRepository.save).toHaveBeenCalled();
      expect(mockMetrics.increment).toHaveBeenCalledWith('notification.created', {
        type: input.type,
        severity: input.severity,
      });
    });

    it('should fail with invalid input', async () => {
      const input = {
        userId: '',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.HIGH,
        title: '',
        message: '',
        channels: [],
        priority: 10,
      };

      const result = await command.execute(input);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Validation failed');
      expect(mockRepository.save).not.toHaveBeenCalled();
    });

    it('should publish event after successful creation', async () => {
      const input = {
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.CRITICAL,
        title: 'Critical Alert',
        message: 'Critical message',
        channels: [NotificationChannel.WEBSOCKET, NotificationChannel.EMAIL],
        priority: 5,
      };

      const mockNotification = new Notification(input);
      mockRepository.save.mockResolvedValue(mockNotification);

      await command.execute(input);

      expect(mockNatsPublisher.publish).toHaveBeenCalledWith(
        'notification.requested',
        expect.any(Buffer)
      );
    });

    it('should handle repository errors', async () => {
      const input = {
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.HIGH,
        title: 'Test',
        message: 'Test',
        channels: [NotificationChannel.WEBSOCKET],
        priority: 0,
      };

      mockRepository.save.mockRejectedValue(new Error('Database error'));

      const result = await command.execute(input);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Database error');
      expect(mockMetrics.increment).toHaveBeenCalledWith('notification.create_failed');
    });
  });

  describe('MarkNotificationReadCommand', () => {
    let command: MarkNotificationReadCommand;

    beforeEach(() => {
      jest.clearAllMocks();
      command = new MarkNotificationReadCommand(
        mockRepository as any,
        mockLogger
      );
    });

    it('should mark notification as read', async () => {
      const notification = new Notification({
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.HIGH,
        title: 'Test',
        message: 'Test',
        channels: [NotificationChannel.WEBSOCKET],
        priority: 0,
      });

      mockRepository.findById.mockResolvedValue(notification);
      mockRepository.save.mockResolvedValue(notification);

      const result = await command.execute({
        notificationId: notification.id,
        userId: 'user_123',
      });

      expect(result.success).toBe(true);
      expect(result.notification?.read).toBe(true);
      expect(mockRepository.save).toHaveBeenCalled();
    });

    it('should fail if notification not found', async () => {
      mockRepository.findById.mockResolvedValue(null);

      const result = await command.execute({
        notificationId: 'notif_123',
        userId: 'user_123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Notification not found');
    });

    it('should fail if user does not own notification', async () => {
      const notification = new Notification({
        userId: 'user_456',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.HIGH,
        title: 'Test',
        message: 'Test',
        channels: [NotificationChannel.WEBSOCKET],
        priority: 0,
      });

      mockRepository.findById.mockResolvedValue(notification);

      const result = await command.execute({
        notificationId: notification.id,
        userId: 'user_123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unauthorized');
    });
  });

  describe('GetNotificationsQuery', () => {
    let query: GetNotificationsQuery;

    beforeEach(() => {
      jest.clearAllMocks();
      query = new GetNotificationsQuery(
        mockRepository as any,
        mockLogger
      );
    });

    it('should get notifications for user', async () => {
      const notifications = [
        new Notification({
          userId: 'user_123',
          type: NotificationType.ALERT,
          severity: NotificationSeverity.HIGH,
          title: 'Test 1',
          message: 'Test',
          channels: [NotificationChannel.WEBSOCKET],
          priority: 0,
        }),
        new Notification({
          userId: 'user_123',
          type: NotificationType.INFO,
          severity: NotificationSeverity.LOW,
          title: 'Test 2',
          message: 'Test',
          channels: [NotificationChannel.EMAIL],
          priority: 0,
        }),
      ];

      mockRepository.findByUserId.mockResolvedValue(notifications);
      mockRepository.countUnreadByUserId.mockResolvedValue(1);

      const result = await query.execute({
        userId: 'user_123',
        limit: 50,
        offset: 0,
      });

      expect(result.notifications).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.unreadCount).toBe(1);
    });

    it('should get only unread notifications', async () => {
      const notifications = [
        new Notification({
          userId: 'user_123',
          type: NotificationType.ALERT,
          severity: NotificationSeverity.HIGH,
          title: 'Unread',
          message: 'Test',
          channels: [NotificationChannel.WEBSOCKET],
          priority: 0,
        }),
      ];

      mockRepository.findUnreadByUserId.mockResolvedValue(notifications);
      mockRepository.countUnreadByUserId.mockResolvedValue(1);

      const result = await query.execute({
        userId: 'user_123',
        unreadOnly: true,
      });

      expect(result.notifications).toHaveLength(1);
      expect(mockRepository.findUnreadByUserId).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      mockRepository.findByUserId.mockRejectedValue(new Error('Database error'));

      const result = await query.execute({
        userId: 'user_123',
      });

      expect(result.notifications).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.unreadCount).toBe(0);
    });
  });

  describe('NotificationValidator', () => {
    it('should validate correct input', () => {
      const input = {
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.HIGH,
        title: 'Test',
        message: 'Test',
        channels: [NotificationChannel.WEBSOCKET],
        priority: 0,
      };

      expect(() => NotificationValidator.validateNotificationInput(input)).not.toThrow();
    });

    it('should fail with empty userId', () => {
      const input = {
        userId: '',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.HIGH,
        title: 'Test',
        message: 'Test',
        channels: [NotificationChannel.WEBSOCKET],
        priority: 0,
      };

      expect(() => NotificationValidator.validateNotificationInput(input)).toThrow();
    });

    it('should fail with invalid priority', () => {
      const input = {
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.HIGH,
        title: 'Test',
        message: 'Test',
        channels: [NotificationChannel.WEBSOCKET],
        priority: 10,
      };

      expect(() => NotificationValidator.validateNotificationInput(input)).toThrow('Priority must be a number between 0 and 5');
    });

    it('should fail with empty channels', () => {
      const input = {
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.HIGH,
        title: 'Test',
        message: 'Test',
        channels: [],
        priority: 0,
      };

      expect(() => NotificationValidator.validateNotificationInput(input)).toThrow('At least one channel is required');
    });

    it('should sanitize strings', () => {
      const result = NotificationValidator.sanitizeString('  <script>alert("xss")</script>  ');
      expect(result).not.toContain('<script>');
      expect(result).not.toContain('</script>');
    });
  });

  describe('End-to-end flow', () => {
    it('should complete full notification lifecycle', async () => {
      // 1. Create notification
      const sendCommand = new SendNotificationCommand(
        mockRepository as any,
        {} as any,
        mockLogger,
        mockMetrics,
        mockNatsPublisher as any
      );

      const createInput = {
        userId: 'user_123',
        type: NotificationType.ALERT,
        severity: NotificationSeverity.CRITICAL,
        title: 'Critical Alert',
        message: 'Critical message',
        channels: [NotificationChannel.WEBSOCKET, NotificationChannel.EMAIL],
        priority: 5,
      };

      const newNotification = new Notification(createInput);
      mockRepository.save.mockResolvedValue(newNotification);

      const createResult = await sendCommand.execute(createInput);
      expect(createResult.success).toBe(true);

      // 2. Get notifications
      const getQuery = new GetNotificationsQuery(
        mockRepository as any,
        mockLogger
      );

      mockRepository.findByUserId.mockResolvedValue([newNotification]);
      mockRepository.countUnreadByUserId.mockResolvedValue(1);

      const getResult = await getQuery.execute({
        userId: 'user_123',
      });

      expect(getResult.notifications).toHaveLength(1);
      expect(getResult.unreadCount).toBe(1);

      // 3. Mark as read
      const markReadCommand = new MarkNotificationReadCommand(
        mockRepository as any,
        mockLogger
      );

      mockRepository.findById.mockResolvedValue(newNotification);
      mockRepository.save.mockResolvedValue(newNotification);

      const markResult = await markReadCommand.execute({
        notificationId: newNotification.id,
        userId: 'user_123',
      });

      expect(markResult.success).toBe(true);
      expect(markResult.notification?.read).toBe(true);
    });
  });
});