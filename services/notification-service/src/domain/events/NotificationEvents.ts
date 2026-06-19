export const NOTIFICATION_EVENTS = {
  REQUESTED: 'notification.requested',
  SENT: 'notification.sent',
  DELIVERED: 'notification.delivered',
  FAILED: 'notification.failed',
  READ: 'notification.read',
} as const;

export interface NotificationRequestedEvent {
  type: typeof NOTIFICATION_EVENTS.REQUESTED;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    notification_id: string;
    user_id: string;
    type: string;
    severity: string;
    title: string;
    message: string;
    data?: Record<string, unknown>;
    channels: string[];
    priority: number;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export interface NotificationSentEvent {
  type: typeof NOTIFICATION_EVENTS.SENT;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    notification_id: string;
    user_id: string;
    channel: string;
    status: 'sent' | 'delivered' | 'failed';
    timestamp: string;
    error?: string;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export interface NotificationDeliveredEvent {
  type: typeof NOTIFICATION_EVENTS.DELIVERED;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    notification_id: string;
    user_id: string;
    channel: string;
    delivered_at: string;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export interface NotificationFailedEvent {
  type: typeof NOTIFICATION_EVENTS.FAILED;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    notification_id: string;
    user_id: string;
    channel: string;
    error: string;
    failed_at: string;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export interface NotificationReadEvent {
  type: typeof NOTIFICATION_EVENTS.READ;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    notification_id: string;
    user_id: string;
    read_at: string;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export type NotificationEvent =
  | NotificationRequestedEvent
  | NotificationSentEvent
  | NotificationDeliveredEvent
  | NotificationFailedEvent
  | NotificationReadEvent;