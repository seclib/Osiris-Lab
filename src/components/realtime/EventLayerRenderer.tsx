'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  type IntelligenceEvent,
  type IntelligenceFeature,
  type IntelligenceFeatureCollection,
  getEventConfidence,
  getEventGeo,
  getEventTimestamp,
  getEventType,
} from '@/lib/event-stream';

type AnimatedPosition = {
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  startedAt: number;
  updatedAt: number;
  event: IntelligenceEvent;
};

type EventLayerRendererProps = {
  events: IntelligenceEvent[];
  children: (features: IntelligenceFeatureCollection) => ReactNode;
  maxFeatures?: number;
  fps?: number;
  transitionMs?: number;
};

const EMPTY_FC: IntelligenceFeatureCollection = { type: 'FeatureCollection', features: [] };

function eventKey(event: IntelligenceEvent): string {
  const eventType = getEventType(event);
  const sourceId = event.source_event?.id || event.id;
  if (eventType === 'adsb' || eventType === 'ais') return `${eventType}:${sourceId}`;
  return event.id;
}

function latestEvents(events: IntelligenceEvent[], maxFeatures: number): IntelligenceEvent[] {
  const byKey = new Map<string, IntelligenceEvent>();
  for (const event of events.slice(-maxFeatures * 3)) {
    byKey.set(eventKey(event), event);
  }
  return [...byKey.values()].slice(-maxFeatures);
}

function interpolatePosition(position: AnimatedPosition, now: number, transitionMs: number) {
  const progress = Math.min(1, Math.max(0, (now - position.startedAt) / transitionMs));
  return {
    lat: position.from.lat + (position.to.lat - position.from.lat) * progress,
    lon: position.from.lon + (position.to.lon - position.from.lon) * progress,
  };
}

function featureFor(event: IntelligenceEvent, geo: { lat: number; lon: number }): IntelligenceFeature {
  const eventType = getEventType(event);
  const score = Math.round(Number(event.score?.final ?? 0));
  const risk = Math.round(Number(event.score?.risk ?? 0));
  const confidence = getEventConfidence(event);
  const severity = String(event.score?.severity || (event.alert ? 'HIGH' : 'INFO')).toUpperCase();
  const title = event.title || `${eventType.toUpperCase()} observed`;

  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [geo.lon, geo.lat],
    },
    properties: {
      id: event.id,
      entity_id: event.source_event?.id || event.id,
      event_type: eventType,
      title,
      severity,
      score,
      risk,
      confidence,
      alert: Boolean(event.alert),
      timestamp: event.source_event?.timestamp || event.timestamp || null,
      source: String(event.source_event?.metadata?.source || 'OSIRIS Core Brain'),
      anomaly_count: event.anomalies?.length || 0,
      correlation_count: event.correlations?.length || 0,
      route: event.route || null,
      agent_summary: event.agent_insight?.summary || null,
      agent_reasoning: event.agent_insight?.reasoning || null,
    },
  };
}

export default function EventLayerRenderer({
  events,
  children,
  maxFeatures = 2000,
  fps = 18,
  transitionMs = 900,
}: EventLayerRendererProps) {
  const positionsRef = useRef<Map<string, AnimatedPosition>>(new Map());
  const latest = useMemo(() => latestEvents(events, maxFeatures), [events, maxFeatures]);
  const [featureCollection, setFeatureCollection] = useState<IntelligenceFeatureCollection>(EMPTY_FC);

  useEffect(() => {
    const now = performance.now();
    const activeKeys = new Set<string>();

    for (const event of latest) {
      const geo = getEventGeo(event);
      if (!geo) continue;

      const key = eventKey(event);
      const existing = positionsRef.current.get(key);
      const current = existing ? interpolatePosition(existing, now, transitionMs) : geo;
      activeKeys.add(key);
      positionsRef.current.set(key, {
        from: current,
        to: geo,
        startedAt: now,
        updatedAt: now,
        event,
      });
    }

    for (const key of positionsRef.current.keys()) {
      if (!activeKeys.has(key)) positionsRef.current.delete(key);
    }
  }, [latest, transitionMs]);

  useEffect(() => {
    let frame = 0;
    let lastFrame = 0;
    const minFrameMs = 1000 / Math.max(1, fps);

    const tick = (now: number) => {
      if (now - lastFrame >= minFrameMs) {
        lastFrame = now;
        const features: IntelligenceFeature[] = [];
        for (const position of positionsRef.current.values()) {
          const eventTime = getEventTimestamp(position.event);
          if (!eventTime) continue;
          features.push(featureFor(position.event, interpolatePosition(position, now, transitionMs)));
        }
        setFeatureCollection({ type: 'FeatureCollection', features });
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [fps, transitionMs]);

  return <>{children(featureCollection)}</>;
}

