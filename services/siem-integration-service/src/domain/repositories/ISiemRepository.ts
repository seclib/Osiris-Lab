import { SIEMConnection, SIEMType, SIEMConnectionStatus } from '../entities/SIEMConnection';

export interface ISiemRepository {
  // Connection management
  saveConnection(connection: SIEMConnection): Promise<SIEMConnection>;
  findConnectionById(id: string): Promise<SIEMConnection | null>;
  findConnectionByName(name: string): Promise<SIEMConnection | null>;
  findAllConnections(): Promise<SIEMConnection[]>;
  findByType(type: SIEMType): Promise<SIEMConnection[]>;
  findByStatus(status: SIEMConnectionStatus): Promise<SIEMConnection[]>;
  deleteConnection(id: string): Promise<boolean>;
  
  // Event logging
  logEvent(data: {
    connectionId: string;
    direction: 'inbound' | 'outbound';
    eventType: string;
    severity: string;
    data: Record<string, unknown>;
    status: 'success' | 'failed';
    error?: string;
  }): Promise<void>;
  
  getEvents(connectionId: string, limit?: number, offset?: number): Promise<Array<Record<string, unknown>>>;
  getEventStats(connectionId: string): Promise<{
    totalEvents: number;
    successCount: number;
    failureCount: number;
    lastEvent?: Date;
  }>;
}