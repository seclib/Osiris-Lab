export enum SIEMType {
  SPLUNK = 'splunk',
  QRADAR = 'qradar',
  ELK = 'elk',
  SENTINEL = 'sentinel',
  ARCSIGHT = 'arcsight',
}

export enum SIEMConnectionStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
  CONNECTING = 'connecting',
}

export enum SIEMEventDirection {
  INBOUND = 'inbound',
  OUTBOUND = 'outbound',
  BIDIRECTIONAL = 'bidirectional',
}

export interface SIEMConnectionProps {
  id?: string;
  name: string;
  type: SIEMType;
  enabled?: boolean;
  config: Record<string, unknown>;
  direction?: SIEMEventDirection;
  status?: SIEMConnectionStatus;
  lastSync?: Date;
  lastError?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export class SIEMConnection {
  public readonly id: string;
  public name: string;
  public readonly type: SIEMType;
  public enabled: boolean;
  public config: Record<string, unknown>;
  public readonly direction: SIEMEventDirection;
  public status: SIEMConnectionStatus;
  public lastSync?: Date;
  public lastError?: string;
  public readonly createdAt: Date;
  public updatedAt: Date;

  constructor(props: SIEMConnectionProps) {
    this.id = props.id || this.generateId();
    this.name = props.name;
    this.type = props.type;
    this.enabled = props.enabled ?? true;
    this.config = props.config;
    this.direction = props.direction || SIEMEventDirection.BIDIRECTIONAL;
    this.status = props.status || SIEMConnectionStatus.INACTIVE;
    this.lastSync = props.lastSync;
    this.lastError = props.lastError;
    this.createdAt = props.createdAt || new Date();
    this.updatedAt = props.updatedAt || new Date();
  }

  private generateId(): string {
    return `siem_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  public activate(): void {
    if (this.status !== SIEMConnectionStatus.ACTIVE) {
      this.status = SIEMConnectionStatus.ACTIVE;
      this.lastError = undefined;
      this.updatedAt = new Date();
    }
  }

  public deactivate(): void {
    this.status = SIEMConnectionStatus.INACTIVE;
    this.updatedAt = new Date();
  }

  public markError(error: string): void {
    this.status = SIEMConnectionStatus.ERROR;
    this.lastError = error;
    this.updatedAt = new Date();
  }

  public updateSync(): void {
    this.lastSync = new Date();
    this.updatedAt = new Date();
  }

  public updateConfig(config: Record<string, unknown>): void {
    this.config = config;
    this.updatedAt = new Date();
  }

  public validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!this.name || this.name.trim().length === 0) {
      errors.push('Connection name is required');
    }

    if (!this.config || Object.keys(this.config).length === 0) {
      errors.push('Connection config is required');
    }

    // Validate config based on SIEM type
    switch (this.type) {
      case SIEMType.SPLUNK:
        if (!this.config.hec_url || !this.config.hec_token) {
          errors.push('Splunk connection requires hec_url and hec_token');
        }
        break;
      case SIEMType.QRADAR:
        if (!this.config.host || !this.config.api_token) {
          errors.push('QRadar connection requires host and api_token');
        }
        break;
      case SIEMType.ELK:
        if (!this.config.host || !this.config.port) {
          errors.push('ELK connection requires host and port');
        }
        break;
      case SIEMType.SENTINEL:
        if (!this.config.tenant_id || !this.config.client_id || !this.config.client_secret) {
          errors.push('Sentinel connection requires tenant_id, client_id and client_secret');
        }
        break;
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  public isActive(): boolean {
    return this.status === SIEMConnectionStatus.ACTIVE && this.enabled;
  }

  public supportsInbound(): boolean {
    return this.direction === SIEMEventDirection.INBOUND || 
           this.direction === SIEMEventDirection.BIDIRECTIONAL;
  }

  public supportsOutbound(): boolean {
    return this.direction === SIEMEventDirection.OUTBOUND || 
           this.direction === SIEMEventDirection.BIDIRECTIONAL;
  }

  public toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      enabled: this.enabled,
      config: this.config,
      direction: this.direction,
      status: this.status,
      lastSync: this.lastSync,
      lastError: this.lastError,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}