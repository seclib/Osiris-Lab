/**
 * OSIRIS-Lab v2 — SIEM Plugin SDK
 * Domain Types for SIEM connectors
 */

// ─── SIEM Connection Types ─────────────────────────────────────────────────

export type SIEMType = 'splunk' | 'qradar' | 'elk' | 'sentinel';

export interface SIEMConnectionConfig {
  id: string;
  name: string;
  type: SIEMType;
  enabled: boolean;
  config: Record<string, string>;
  lastSync?: Date;
  status: 'active' | 'error' | 'disabled';
  createdAt: Date;
  updatedAt: Date;
}

// ─── Alert Types ────────────────────────────────────────────────────────────

export interface SIEMAlert {
  alertId: string;
  osirisAlertId: string;
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  source: string;
  timestamp: Date;
  iocs: string[];
  entities: string[];
  raw: Record<string, unknown>;
}

export interface SIEMAlertResult {
  siemId: string;
  alertId: string;
  osirisAlertId: string;
  status: 'sent' | 'failed';
  error?: string;
  timestamp: Date;
}

// ─── Event Types ────────────────────────────────────────────────────────────

export interface SIEMExternalEvent {
  eventId: string;
  siemId: string;
  siemType: SIEMType;
  eventType: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  data: Record<string, unknown>;
  receivedAt: Date;
}

// ─── Connector Interface ──────────────────────────────────────────────────

export interface SIEMConnectorConfig {
  baseUrl: string;
  authToken: string;
  timeout?: number;
  pollInterval?: number;
  retryAttempts?: number;
}

export type ConnectorHealthStatus = 'healthy' | 'unhealthy' | 'disconnected' | 'not_initialized';

export interface SIEMConnectorHealth {
  status: ConnectorHealthStatus;
  lastCheck: Date;
  latencyMs: number;
  error?: string;
}