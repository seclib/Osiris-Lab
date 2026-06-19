import { Notification, NotificationType, NotificationSeverity, NotificationChannel } from '../entities/Notification';

export class NotificationValidator {
  /**
   * Validate notification input data
   * @throws Error if validation fails
   */
  static validateNotificationInput(data: {
    userId: string;
    type: NotificationType;
    severity: NotificationSeverity;
    title: string;
    message: string;
    channels: NotificationChannel[];
    priority: number;
  }): void {
    const errors: string[] = [];

    // User ID validation
    if (!data.userId || typeof data.userId !== 'string' || data.userId.trim() === '') {
      errors.push('Valid user ID is required');
    }

    // Title validation
    if (!data.title || typeof data.title !== 'string' || data.title.trim() === '') {
      errors.push('Title is required');
    }
    if (data.title && data.title.length > 500) {
      errors.push('Title must be less than 500 characters');
    }

    // Message validation
    if (!data.message || typeof data.message !== 'string' || data.message.trim() === '') {
      errors.push('Message is required');
    }
    if (data.message && data.message.length > 10000) {
      errors.push('Message must be less than 10000 characters');
    }

    // Channels validation
    if (!Array.isArray(data.channels) || data.channels.length === 0) {
      errors.push('At least one channel is required');
    }

    // Priority validation
    if (typeof data.priority !== 'number' || data.priority < 0 || data.priority > 5) {
      errors.push('Priority must be a number between 0 and 5');
    }

    // Type validation
    if (!Object.values(NotificationType).includes(data.type)) {
      errors.push('Invalid notification type');
    }

    // Severity validation
    if (!Object.values(NotificationSeverity).includes(data.severity)) {
      errors.push('Invalid notification severity');
    }

    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join(', ')}`);
    }
  }

  /**
   * Validate notification ID format
   */
  static validateNotificationId(id: string): boolean {
    return typeof id === 'string' && id.startsWith('notif_') && id.length > 10;
  }

  /**
   * Validate user ID format
   */
  static validateUserId(userId: string): boolean {
    return typeof userId === 'string' && userId.length > 0;
  }

  /**
   * Sanitize string input (prevent XSS)
   */
  static sanitizeString(input: string): string {
    return input
      .trim()
      .replace(/[<>]/g, '') // Remove HTML tags
      .substring(0, 10000); // Limit length
  }

  /**
   * Validate and sanitize notification data
   */
  static sanitizeAndValidate(data: {
    userId: string;
    type: NotificationType;
    severity: NotificationSeverity;
    title: string;
    message: string;
    channels: NotificationChannel[];
    priority: number;
  }): {
    userId: string;
    type: NotificationType;
    severity: NotificationSeverity;
    title: string;
    message: string;
    channels: NotificationChannel[];
    priority: number;
  } {
    return {
      userId: this.sanitizeString(data.userId),
      type: data.type,
      severity: data.severity,
      title: this.sanitizeString(data.title).substring(0, 500),
      message: this.sanitizeString(data.message),
      channels: data.channels,
      priority: Math.max(0, Math.min(5, data.priority)),
    };
  }
}