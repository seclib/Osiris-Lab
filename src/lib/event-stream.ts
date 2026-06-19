export type EventType = 'adsb' | 'ais' | 'weather' | 'quake' | 'wildfire';

export type EventBbox = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type EventFilterState = {
  types: Record<EventType, boolean>;
  minConfidence: number;
  bbox: EventBbox | null;
  timeRangeMinutes: number;
};

export type IntelligenceEvent = {
  id: string;
  type: 'intelligence_event' | string;
  route?: string;
  title?: string;
  timestamp?: string;
  source_stream_id?: string;
  source_event?: {
    id?: string;
    type?: EventType | string;
    timestamp?: string;
    geo?: {
      lat?: number;
      lon?: number;
      lng?: number;
    };
    metadata?: {
      confidence?: number;
      source?: string;
      [key: string]: unknown;
    };
  };
  anomalies?: Array<{ type?: string; severity?: string; [key: string]: unknown }>;
  correlations?: Array<{ target_type?: string; target_event_id?: string; [key: string]: unknown }>;
  score?: {
    importance?: number;
    risk?: number;
    confidence?: number;
    final?: number;
    severity?: string;
    [key: string]: unknown;
  };
  agent_insight?: {
    event_id?: string;
    intelligence_id?: string;
    type?: 'insight' | 'alert' | 'anomaly' | string;
    risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | string;
    summary?: string;
    reasoning?: string;
    geo_context?: Record<string, unknown>;
    emitted_at?: string;
    [key: string]: unknown;
  };
  alert?: boolean;
};

export type IntelligenceFeature = {
  type: 'Feature';
  geometry: {
    type: 'Point';
    coordinates: [number, number];
  };
  properties: Record<string, string | number | boolean | null>;
};

export type IntelligenceFeatureCollection = {
  type: 'FeatureCollection';
  features: IntelligenceFeature[];
};

export const EVENT_TYPES: EventType[] = ['adsb', 'ais', 'weather', 'quake', 'wildfire'];

export const DEFAULT_EVENT_FILTERS: EventFilterState = {
  types: {
    adsb: true,
    ais: true,
    weather: true,
    quake: true,
    wildfire: true,
  },
  minConfidence: 40,
  bbox: null,
  timeRangeMinutes: 60,
};

export function getEventType(event: IntelligenceEvent): EventType | 'unknown' {
  const type = event.source_event?.type;
  if (type === 'adsb' || type === 'ais' || type === 'weather' || type === 'quake' || type === 'wildfire') return type;
  return 'unknown';
}

export function getEventGeo(event: IntelligenceEvent): { lat: number; lon: number } | null {
  const geo = event.source_event?.geo;
  const lat = Number(geo?.lat);
  const lon = Number(geo?.lon ?? geo?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

export function getEventTimestamp(event: IntelligenceEvent): number {
  const raw = event.source_event?.timestamp || event.timestamp;
  const time = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(time) ? time : 0;
}

export function getEventConfidence(event: IntelligenceEvent): number {
  const scoreConfidence = Number(event.score?.confidence);
  const metadataConfidence = Number(event.source_event?.metadata?.confidence);
  const value = Number.isFinite(scoreConfidence) ? scoreConfidence : metadataConfidence;
  if (!Number.isFinite(value)) return 0;
  return value <= 1 ? Math.round(value * 100) : Math.round(value);
}

export function bboxContains(bbox: EventBbox, lat: number, lon: number): boolean {
  const withinLat = lat >= bbox.south && lat <= bbox.north;
  if (!withinLat) return false;

  if (bbox.west <= bbox.east) {
    return lon >= bbox.west && lon <= bbox.east;
  }

  return lon >= bbox.west || lon <= bbox.east;
}

export function filterIntelligenceEvents(
  events: IntelligenceEvent[],
  filters: EventFilterState,
  now = Date.now(),
): IntelligenceEvent[] {
  const earliest = now - filters.timeRangeMinutes * 60_000;

  return events.filter((event) => {
    const eventType = getEventType(event);
    if (eventType === 'unknown' || !filters.types[eventType]) return false;
    if (getEventConfidence(event) < filters.minConfidence) return false;

    const eventTime = getEventTimestamp(event);
    if (!eventTime || eventTime < earliest || eventTime > now + 60_000) return false;

    if (filters.bbox) {
      const geo = getEventGeo(event);
      if (!geo || !bboxContains(filters.bbox, geo.lat, geo.lon)) return false;
    }

    return true;
  });
}

export function intelligenceEventsToFeatureCollection(events: IntelligenceEvent[]): IntelligenceFeatureCollection {
  const features = events.flatMap((event) => {
    const geo = getEventGeo(event);
    if (!geo) return [];

    const eventType = getEventType(event);
    const score = Math.round(Number(event.score?.final ?? 0));
    const risk = Math.round(Number(event.score?.risk ?? 0));
    const confidence = getEventConfidence(event);
    const severity = String(event.score?.severity || (event.alert ? 'HIGH' : 'INFO')).toUpperCase();
    const title = event.title || `${eventType.toUpperCase()} observed`;

    return [{
      type: 'Feature' as const,
      geometry: {
        type: 'Point' as const,
        coordinates: [geo.lon, geo.lat] as [number, number],
      },
      properties: {
        id: event.id,
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
    }];
  });

  return { type: 'FeatureCollection', features };
}
