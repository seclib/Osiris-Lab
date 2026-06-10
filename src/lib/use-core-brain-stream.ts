'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IntelligenceEvent } from '@/lib/event-stream';

export type CoreBrainStreamStatus = 'connecting' | 'connected' | 'reconnecting' | 'error';

type CoreBrainMessage =
  | { type: 'hello'; service?: string; time?: string }
  | { type: 'snapshot'; events?: IntelligenceEvent[]; time?: string }
  | { type: 'intelligence.update'; intelligence?: IntelligenceEvent; time?: string };

type StreamOptions = {
  maxEvents?: number;
  flushMs?: number;
};

function dedupeAndBound(events: IntelligenceEvent[], maxEvents: number): IntelligenceEvent[] {
  const byId = new Map<string, IntelligenceEvent>();
  for (const event of events) {
    if (!event?.id) continue;
    byId.set(event.id, event);
  }
  return [...byId.values()]
    .sort((a, b) => {
      const at = Date.parse(a.timestamp || a.source_event?.timestamp || '') || 0;
      const bt = Date.parse(b.timestamp || b.source_event?.timestamp || '') || 0;
      return at - bt;
    })
    .slice(-maxEvents);
}

function defaultStreamUrl(): string {
  if (typeof window === 'undefined') return '';
  const configured = process.env.NEXT_PUBLIC_CORE_BRAIN_WS_URL;
  if (configured) return configured;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/core-brain/stream`;
}

export function useCoreBrainStream(options: StreamOptions = {}) {
  const maxEvents = options.maxEvents ?? 1500;
  const flushMs = options.flushMs ?? 250;
  const [status, setStatus] = useState<CoreBrainStreamStatus>('connecting');
  const [events, setEvents] = useState<IntelligenceEvent[]>([]);
  const [lastMessageAt, setLastMessageAt] = useState<string | null>(null);
  const [statsState, setStatsState] = useState({
    buffered: 0,
    dropped: 0,
    received: 0,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const queueRef = useRef<IntelligenceEvent[]>([]);
  const statsRef = useRef({
    buffered: 0,
    dropped: 0,
    received: 0,
  });
  const lastMessageRef = useRef<string | null>(null);
  const streamUrl = useMemo(() => defaultStreamUrl(), []);

  const flushQueue = useCallback(() => {
    const queued = queueRef.current.splice(0);
    statsRef.current.buffered = 0;
    setStatsState({ ...statsRef.current });
    if (!queued.length) return;

    setEvents((previous) => dedupeAndBound([...previous, ...queued], maxEvents));
    setLastMessageAt(lastMessageRef.current);
  }, [maxEvents]);

  useEffect(() => {
    if (!streamUrl) return undefined;

    let cancelled = false;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    const flushTimer = window.setInterval(flushQueue, flushMs);

    const scheduleReconnect = () => {
      if (cancelled) return;
      reconnectAttempt += 1;
      const delay = Math.min(30_000, 750 * 2 ** Math.min(reconnectAttempt, 6));
      setStatus('reconnecting');
      reconnectTimer = window.setTimeout(connect, delay);
    };

    const handleEvent = (event: IntelligenceEvent) => {
      if (!event?.id) return;
      if (queueRef.current.length > maxEvents) {
        queueRef.current.splice(0, queueRef.current.length - maxEvents);
        statsRef.current.dropped += 1;
      }
      queueRef.current.push(event);
      statsRef.current.received += 1;
      statsRef.current.buffered = queueRef.current.length;
      lastMessageRef.current = new Date().toISOString();
    };

    const handleMessage = (raw: string) => {
      let message: CoreBrainMessage;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      if (message.type === 'snapshot') {
        const snapshot = Array.isArray(message.events) ? message.events : [];
        setEvents(dedupeAndBound(snapshot, maxEvents));
        setLastMessageAt(message.time || new Date().toISOString());
        statsRef.current.received += snapshot.length;
        setStatsState({ ...statsRef.current });
        return;
      }

      if (message.type === 'intelligence.update' && message.intelligence) {
        handleEvent(message.intelligence);
      }
    };

    function connect() {
      if (cancelled) return;
      setStatus(reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

      const ws = new WebSocket(streamUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempt = 0;
        setStatus('connected');
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') handleMessage(event.data);
      };

      ws.onerror = () => {
        setStatus('error');
      };

      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        scheduleReconnect();
      };
    }

    const initialConnectTimer = window.setTimeout(connect, 0);

    return () => {
      cancelled = true;
      window.clearInterval(flushTimer);
      window.clearTimeout(initialConnectTimer);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [flushMs, flushQueue, maxEvents, streamUrl]);

  return {
    events,
    status: streamUrl ? status : 'error',
    streamUrl,
    lastMessageAt,
    stats: {
      buffered: statsState.buffered,
      dropped: statsState.dropped,
      received: statsState.received,
      retained: events.length,
    },
  };
}
