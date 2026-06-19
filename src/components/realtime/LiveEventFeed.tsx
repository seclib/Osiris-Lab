'use client';

import { AlertTriangle, Radio } from 'lucide-react';
import {
  type IntelligenceEvent,
  getEventConfidence,
  getEventGeo,
  getEventTimestamp,
  getEventType,
} from '@/lib/event-stream';

type LiveEventFeedProps = {
  events: IntelligenceEvent[];
  onLocate?: (lat: number, lon: number) => void;
};

const TYPE_COLORS = {
  adsb: '#00E5FF',
  ais: '#4FC3F7',
  weather: '#E040FB',
  quake: '#FF9500',
  wildfire: '#FF6B00',
  unknown: '#D4AF37',
};

function formatTime(value: number): string {
  if (!value) return '--:--';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value);
}

export default function LiveEventFeed({ events, onLocate }: LiveEventFeedProps) {
  const visibleEvents = events.slice(-80).reverse();

  if (visibleEvents.length === 0) {
    return (
      <div className="px-3 py-8 text-center">
        <Radio className="w-5 h-5 mx-auto mb-2 text-[var(--text-muted)]" />
        <div className="hud-label">NO MATCHING EVENTS</div>
      </div>
    );
  }

  return (
    <div className="divide-y divide-white/5">
      {visibleEvents.map((event) => {
        const type = getEventType(event);
        const geo = getEventGeo(event);
        const confidence = getEventConfidence(event);
        const eventTime = getEventTimestamp(event);
        const severity = String(event.score?.severity || (event.alert ? 'HIGH' : 'INFO')).toUpperCase();
        const color = TYPE_COLORS[type];

        return (
          <button
            key={event.id}
            type="button"
            onClick={() => geo && onLocate?.(geo.lat, geo.lon)}
            className="w-full text-left px-3 py-2.5 hover:bg-white/5 transition-colors"
          >
            <div className="flex items-start gap-2">
              <div className="mt-1 w-2 h-2 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[9px] font-mono font-bold truncate" style={{ color }}>
                    {type.toUpperCase()}
                  </span>
                  <span className="text-[8px] font-mono text-[var(--text-muted)] shrink-0">{formatTime(eventTime)}</span>
                </div>
                <div className="text-[10px] leading-snug text-[var(--text-primary)] truncate mt-0.5">
                  {event.agent_insight?.summary || event.title || `${type.toUpperCase()} observed`}
                </div>
                <div className="mt-1 flex items-center gap-2 text-[8px] font-mono text-[var(--text-muted)]">
                  <span className={event.alert ? 'text-[var(--alert-red)]' : ''}>{severity}</span>
                  <span>{confidence}%</span>
                  <span>{event.anomalies?.length || 0}A</span>
                  <span>{event.correlations?.length || 0}C</span>
                </div>
              </div>
              {event.alert && <AlertTriangle className="w-3.5 h-3.5 text-[var(--alert-red)] shrink-0 mt-0.5" />}
            </div>
          </button>
        );
      })}
    </div>
  );
}

