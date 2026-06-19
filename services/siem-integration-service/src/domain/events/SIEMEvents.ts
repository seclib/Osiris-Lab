export const SIEM_EVENTS = {
  ALERT_SENT: 'siem.alert.sent',
  EVENT_RECEIVED: 'siem.event.received',
  CONNECTION_CREATED: 'siem.connection.created',
  CONNECTION_UPDATED: 'siem.connection.updated',
  CONNECTION_DELETED: 'siem.connection.deleted',
  CONNECTION_STATUS_CHANGED: 'siem.connection.status.changed',
} as const;

export interface SIEMAlertSentEvent {
  type: typeof SIEM_EVENTS.ALERT_SENT;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    siem_id: string;
    alert_id: string;
    osiris_alert_id: string;
    status: 'sent' | 'failed';
    error?: string;
    timestamp: string;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export interface SIEMEventReceivedEvent {
  type: typeof SIEM_EVENTS.EVENT_RECEIVED;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    siem_id: string;
    event_id: string;
    event_type: string;
    severity: string;
    data: Record<string, unknown>;
    timestamp: string;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export interface SIEMConnectionCreatedEvent {
  type: typeof SIEM_EVENTS.CONNECTION_CREATED;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    connection_id: string;
    name: string;
    type: string;
    direction: string;
    created_by: string;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export interface SIEMConnectionUpdatedEvent {
  type: typeof SIEM_EVENTS.CONNECTION_UPDATED;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    connection_id: string;
    changes: Record<string, unknown>;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export interface SIEMConnectionDeletedEvent {
  type: typeof SIEM_EVENTS.CONNECTION_DELETED;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    connection_id: string;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export interface SIEMConnectionStatusChangedEvent {
  type: typeof SIEM_EVENTS.CONNECTION_STATUS_CHANGED;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    connection_id: string;
    old_status: string;
    new_status: string;
    error?: string;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export type SIEMEvent =
  | SIEMAlertSentEvent
  | SIEMEventReceivedEvent
  | SIEMConnectionCreatedEvent
  | SIEMConnectionUpdatedEvent
  | SIEMConnectionDeletedEvent
  | SIEMConnectionStatusChangedEvent;