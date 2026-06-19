/**
 * Shared constants for notification-service
 */

export const ServiceName = 'notification-service';
export const ServiceVersion = '1.0.0';

export const EventSubjects = {
  NOTIFICATION_REQUESTED: 'notification.requested',
  NOTIFICATION_SENT: 'notification.sent',
  NOTIFICATION_DELIVERED: 'notification.delivered',
  NOTIFICATION_FAILED: 'notification.failed',
  NOTIFICATION_READ: 'notification.read',
} as const;

export const MetricNames = {
  NOTIFICATION_CREATED: 'notification.created',
  NOTIFICATION_VALIDATION_FAILED: 'notification.validation_failed',
  NOTIFICATION_CREATE_FAILED: 'notification.create_failed',
  NOTIFICATION_CREATE_DURATION_MS: 'notification.create_duration_ms',
  NOTIFICATION_EVENT_PUBLISH_FAILED: 'notification.event_publish_failed',
} as const;

export const DefaultValues = {
  PRIORITY: 0,
  LIMIT: 50,
  OFFSET: 0,
} as const;

export const ID_PREFIX = 'notif_';
export const ID_TIMESTAMP_LENGTH = 13;
export const ID_RANDOM_LENGTH = 9;