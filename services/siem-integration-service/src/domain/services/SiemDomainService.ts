import { SIEMConnection, SIEMType, SIEMConnectionStatus, SIEMEventDirection } from '../entities/SIEMConnection';

export interface SiemValidationResult {
  valid: boolean;
  errors: string[];
}

export interface AlertForwardingConfig {
  enabled: boolean;
  severityFilter: string[];
  eventTypeFilter: string[];
  enrichWithOSIRISData: boolean;
}

export interface EventPollingConfig {
  enabled: boolean;
  pollInterval: number; // seconds
  batchSize: number;
  lastEventTimestamp?: string;
}

export class SiemDomainService {
  /**
   * Validate SIEM connection
   */
  validateConnection(connection: SIEMConnection): SiemValidationResult {
    return connection.validate();
  }

  /**
   * Check if connection can send alerts
   */
  canSendAlerts(connection: SIEMConnection): boolean {
    return connection.isActive() && connection.supportsOutbound();
  }

  /**
   * Check if connection can receive events
   */
  canReceiveEvents(connection: SIEMConnection): boolean {
    return connection.isActive() && connection.supportsInbound();
  }

  /**
   * Get SIEM-specific configuration for alert forwarding
   */
  getAlertForwardingConfig(connection: SIEMConnection): AlertForwardingConfig {
    const defaultConfig: AlertForwardingConfig = {
      enabled: true,
      severityFilter: ['high', 'critical'],
      eventTypeFilter: ['security_event', 'threat_detected', 'ioc_match'],
      enrichWithOSIRISData: true,
    };

    // Customize based on SIEM type
    switch (connection.type) {
      case SIEMType.SPLUNK:
        return {
          ...defaultConfig,
          eventTypeFilter: [...defaultConfig.eventTypeFilter, 'alert'],
        };
      case SIEMType.QRADAR:
        return {
          ...defaultConfig,
          severityFilter: ['medium', 'high', 'critical'],
        };
      case SIEMType.ELK:
        return {
          ...defaultConfig,
          eventTypeFilter: [...defaultConfig.eventTypeFilter, 'log', 'metric'],
        };
      default:
        return defaultConfig;
    }
  }

  /**
   * Get SIEM-specific configuration for event polling
   */
  getEventPollingConfig(connection: SIEMConnection): EventPollingConfig {
    const defaultConfig: EventPollingConfig = {
      enabled: true,
      pollInterval: 60, // 1 minute
      batchSize: 100,
    };

    // Customize based on SIEM type
    switch (connection.type) {
      case SIEMType.SPLUNK:
        return {
          ...defaultConfig,
          pollInterval: 30, // 30 seconds
          batchSize: 500,
        };
      case SIEMType.QRADAR:
        return {
          ...defaultConfig,
          pollInterval: 60,
          batchSize: 200,
        };
      case SIEMType.ELK:
        return {
          ...defaultConfig,
          pollInterval: 120, // 2 minutes
          batchSize: 1000,
        };
      default:
        return defaultConfig;
    }
  }

  /**
   * Transform OSIRIS alert to SIEM format
   */
  transformAlertToSIEM(alert: {
    id: string;
    type: string;
    severity: string;
    title: string;
    description: string;
    entities: string[];
    iocs: string[];
    createdAt: string;
  }, connection: SIEMConnection): Record<string, unknown> {
    const baseEvent = {
      osiris_alert_id: alert.id,
      event_type: 'security_alert',
      severity: this.mapSeverity(alert.severity),
      timestamp: alert.createdAt,
      title: alert.title,
      description: alert.description,
      source: 'osiris',
      entities: alert.entities,
      iocs: alert.iocs,
    };

    // Transform based on SIEM type
    switch (connection.type) {
      case SIEMType.SPLUNK:
        return {
          ...baseEvent,
          event: 'alert',
          fields: {
            osiris_alert_id: alert.id,
            severity: alert.severity,
            alert_type: alert.type,
          },
        };
      case SIEMType.QRADAR:
        return {
          ...baseEvent,
          eventType: 'OSIRIS Alert',
          domainId: 'osiris',
          severity: this.mapQRadarSeverity(alert.severity),
        };
      case SIEMType.ELK:
        return {
          ...baseEvent,
          _index: 'osiris-alerts',
          _type: '_doc',
        };
      default:
        return baseEvent;
    }
  }

  /**
   * Transform SIEM event to OSIRIS format
   */
  transformEventFromSIEM(event: Record<string, unknown>, connection: SIEMConnection): Record<string, unknown> {
    const baseEvent = {
      siem_id: connection.id,
      event_type: event.event_type || event.eventType || 'unknown',
      severity: this.normalizeSeverity(event.severity),
      timestamp: event.timestamp || new Date().toISOString(),
      data: event,
      source: connection.type,
    };

    return baseEvent;
  }

  /**
   * Map OSIRIS severity to SIEM severity
   */
  private mapSeverity(severity: string): string {
    const severityMap: Record<string, string> = {
      low: 'low',
      medium: 'medium',
      high: 'high',
      critical: 'critical',
    };
    return severityMap[severity] || 'medium';
  }

  /**
   * Map OSIRIS severity to QRadar severity (1-10)
   */
  private mapQRadarSeverity(severity: string): number {
    const severityMap: Record<string, number> = {
      low: 2,
      medium: 4,
      high: 7,
      critical: 10,
    };
    return severityMap[severity] || 4;
  }

  /**
   * Normalize SIEM severity to OSIRIS format
   */
  private normalizeSeverity(severity: unknown): string {
    const sev = String(severity).toLowerCase();
    if (['low', 'medium', 'high', 'critical'].includes(sev)) {
      return sev;
    }
    return 'medium';
  }

  /**
   * Calculate retry delay for failed operations
   */
  getRetryDelay(attempt: number, baseDelay: number = 1000): number {
    const maxDelay = 30000; // 30 seconds
    const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
    return delay;
  }

  /**
   * Determine if an event should be retried
   */
  shouldRetry(error: string, attempt: number): boolean {
    if (attempt >= 3) {
      return false;
    }

    // Retry on network errors
    if (error.includes('timeout') || error.includes('ECONNREFUSED') || error.includes('ENOTFOUND')) {
      return true;
    }

    // Retry on rate limit
    if (error.includes('429') || error.includes('rate limit')) {
      return true;
    }

    // Don't retry on auth errors
    if (error.includes('401') || error.includes('403') || error.includes('auth')) {
      return false;
    }

    // Default: retry once
    return attempt < 1;
  }

  /**
   * Validate event data before sending to SIEM
   */
  validateEventData(data: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!data.event_type && !data.eventType) {
      errors.push('Event type is required');
    }

    if (!data.timestamp) {
      errors.push('Event timestamp is required');
    }

    if (!data.severity) {
      errors.push('Event severity is required');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}