/**
 * OSIRIS-Lab v2 — SIEM Plugin SDK
 * Domain events for SIEM operations
 */

import { SIEMAlert, SIEMAlertResult, SIEMExternalEvent } from './types';

export interface SIEMEventBase {
  id: string;
  timestamp: string;
  source: string;
  correlationId?: string;
}

export interface SIEMAlertSentEvent extends SIEMEventBase {
  type: 'siem.alert.sent';
  payload: SIEMAlertResult;
}

export interface SIEMAlertFailedEvent extends SIEMEventBase {
  type: 'siem.alert.failed';
  payload: {
    siemId: string;
    alertId: string;
    error: string;
    timestamp: string;
  };
}

export interface SIEMEventReceivedEvent extends SIEMEventBase {
  type: 'siem.event.received';
  payload: SIEMExternalEvent;
}

export type SIEMDomainEvent = SIEMAlertSentEvent | SIEMAlertFailedEvent | SIEMEventReceivedEvent;