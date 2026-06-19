import { Notification, NotificationChannel, NotificationSeverity, NotificationType } from '../entities/Notification';

export interface DeliveryResult {
  channel: NotificationChannel;
  success: boolean;
  error?: string;
  timestamp: Date;
}

export interface NotificationPreferences {
  userId: string;
  channels: {
    [key in NotificationType]: NotificationChannel[];
  };
  quietHours?: {
    enabled: boolean;
    start: string; // HH:mm format
    end: string;
  };
}

export class NotificationDomainService {
  /**
   * Validate notification business rules
   */
  validate(notification: Notification): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Title must not be empty
    if (!notification.title || notification.title.trim().length === 0) {
      errors.push('Notification title cannot be empty');
    }

    // Message must not be empty
    if (!notification.message || notification.message.trim().length === 0) {
      errors.push('Notification message cannot be empty');
    }

    // Priority must be between 0 and 5
    if (notification.priority < 0 || notification.priority > 5) {
      errors.push('Notification priority must be between 0 and 5');
    }

    // At least one channel required
    if (notification.channels.length === 0) {
      errors.push('At least one notification channel is required');
    }

    // Critical notifications must have high priority
    if (notification.severity === NotificationSeverity.CRITICAL && notification.priority < 3) {
      errors.push('Critical notifications must have priority >= 3');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Determine if notification should be sent based on user preferences
   */
  shouldSend(
    notification: Notification,
    preferences: NotificationPreferences,
    channel: NotificationChannel
  ): boolean {
    // Check if channel is enabled for this notification type
    const enabledChannels = preferences.channels[notification.type];
    if (!enabledChannels || !enabledChannels.includes(channel)) {
      return false;
    }

    // Check quiet hours
    if (preferences.quietHours?.enabled && this.isInQuietHours(preferences.quietHours)) {
      // Only send critical notifications during quiet hours
      return notification.severity === NotificationSeverity.CRITICAL;
    }

    return true;
  }

  /**
   * Calculate delivery priority based on severity and notification priority
   */
  calculateDeliveryPriority(notification: Notification): number {
    const severityWeight = {
      [NotificationSeverity.LOW]: 1,
      [NotificationSeverity.MEDIUM]: 2,
      [NotificationSeverity.HIGH]: 3,
      [NotificationSeverity.CRITICAL]: 4,
    };

    return severityWeight[notification.severity] * 10 + notification.priority;
  }

  /**
   * Aggregate delivery results
   */
  aggregateDeliveryResults(results: DeliveryResult[]): {
    allSucceeded: boolean;
    succeeded: number;
    failed: number;
    errors: string[];
  } {
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const errors = results.filter((r) => r.error).map((r) => r.error as string);

    return {
      allSucceeded: failed === 0,
      succeeded,
      failed,
      errors,
    };
  }

  /**
   * Check if current time is within quiet hours
   */
  private isInQuietHours(quietHours: { start: string; end: string }): boolean {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    if (quietHours.start <= quietHours.end) {
      return currentTime >= quietHours.start && currentTime <= quietHours.end;
    } else {
      // Quiet hours span midnight
      return currentTime >= quietHours.start || currentTime <= quietHours.end;
    }
  }

  /**
   * Determine retry strategy for failed notifications
   */
  getRetryStrategy(error: string, attempt: number): { shouldRetry: boolean; delayMs: number } {
    // Don't retry after 3 attempts
    if (attempt >= 3) {
      return { shouldRetry: false, delayMs: 0 };
    }

    // Retry on network errors
    if (error.includes('timeout') || error.includes('ECONNREFUSED') || error.includes('ENOTFOUND')) {
      const delayMs = Math.min(1000 * Math.pow(2, attempt), 30000); // Exponential backoff, max 30s
      return { shouldRetry: true, delayMs };
    }

    // Don't retry on authentication errors
    if (error.includes('401') || error.includes('403') || error.includes('auth')) {
      return { shouldRetry: false, delayMs: 0 };
    }

    // Default: retry once
    return { shouldRetry: attempt < 1, delayMs: 5000 };
  }
}