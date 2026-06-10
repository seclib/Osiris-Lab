'use client';

import type { Dispatch, SetStateAction } from 'react';
import {
  Activity,
  AlertTriangle,
  Clock3,
  CloudLightning,
  Filter,
  Flame,
  LocateFixed,
  MapPin,
  Plane,
  Radio,
  Ship,
  X,
} from 'lucide-react';
import type { CoreBrainStreamStatus } from '@/lib/use-core-brain-stream';
import {
  EVENT_TYPES,
  type EventBbox,
  type EventFilterState,
  type EventType,
  type IntelligenceEvent,
  getEventConfidence,
  getEventGeo,
  getEventTimestamp,
  getEventType,
} from '@/lib/event-stream';

type EventStreamPanelProps = {
  events: IntelligenceEvent[];
  filteredEvents: IntelligenceEvent[];
  filters: EventFilterState;
  setFilters: Dispatch<SetStateAction<EventFilterState>>;
  streamStatus: CoreBrainStreamStatus;
  streamStats: {
    buffered: number;
    dropped: number;
    received: number;
    retained: number;
  };
  currentBbox: EventBbox | null;
  isMobile?: boolean;
  onLocate?: (lat: number, lon: number) => void;
};

const TYPE_META: Record<EventType, { label: string; icon: typeof Activity; color: string }> = {
  adsb: { label: 'ADS-B', icon: Plane, color: '#00E5FF' },
  ais: { label: 'AIS', icon: Ship, color: '#4FC3F7' },
  weather: { label: 'WX', icon: CloudLightning, color: '#E040FB' },
  quake: { label: 'QUAKE', icon: Activity, color: '#FF9500' },
  wildfire: { label: 'FIRE', icon: Flame, color: '#FF6B00' },
};

const TIME_WINDOWS = [
  { label: '15M', minutes: 15 },
  { label: '1H', minutes: 60 },
  { label: '6H', minutes: 360 },
  { label: '24H', minutes: 1440 },
];

function statusColor(status: CoreBrainStreamStatus): string {
  if (status === 'connected') return 'var(--alert-green)';
  if (status === 'reconnecting' || status === 'connecting') return 'var(--gold-primary)';
  return 'var(--alert-red)';
}

function formatTime(value: number): string {
  if (!value) return '--:--';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value);
}

function formatCoord(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '';
}

export default function EventStreamPanel({
  events,
  filteredEvents,
  filters,
  setFilters,
  streamStatus,
  streamStats,
  currentBbox,
  isMobile = false,
  onLocate,
}: EventStreamPanelProps) {
  const visibleEvents = filteredEvents.slice(-80).reverse();

  const patchFilters = (patch: Partial<EventFilterState>) => {
    setFilters((current) => ({ ...current, ...patch }));
  };

  const patchBbox = (field: keyof EventBbox, value: string) => {
    const parsed = Number(value);
    setFilters((current) => {
      const base = current.bbox || currentBbox || { west: -180, south: -90, east: 180, north: 90 };
      return {
        ...current,
        bbox: {
          ...base,
          [field]: Number.isFinite(parsed) ? parsed : base[field],
        },
      };
    });
  };

  const useMapBounds = () => {
    if (!currentBbox) return;
    patchFilters({ bbox: currentBbox });
  };

  return (
    <div className={`glass-panel osiris-glow-cyan pointer-events-auto flex flex-col overflow-hidden ${isMobile ? 'w-full max-h-[48vh]' : 'w-[380px] max-h-[min(720px,84vh)]'}`}>
      <div className="flex items-center justify-between gap-3 px-3 py-3 border-b border-[var(--border-secondary)]">
        <div className="flex items-center gap-2 min-w-0">
          <Filter className="w-4 h-4 text-[var(--cyan-primary)] shrink-0" />
          <span className="hud-text text-[10px] text-[var(--text-primary)] truncate">EVENT FILTERS</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[8px] font-mono text-[var(--text-muted)]">{filteredEvents.length}/{events.length}</span>
          <span className="inline-flex items-center gap-1 text-[8px] font-mono" style={{ color: statusColor(streamStatus) }}>
            <span className="w-1.5 h-1.5 rounded-full animate-osiris-pulse" style={{ background: statusColor(streamStatus) }} />
            {streamStatus.toUpperCase()}
          </span>
        </div>
      </div>

      <div className="px-3 py-3 space-y-3 border-b border-[var(--border-secondary)]">
        <div className="grid grid-cols-5 gap-1.5">
          {EVENT_TYPES.map((type) => {
            const meta = TYPE_META[type];
            const Icon = meta.icon;
            const active = filters.types[type];
            return (
              <button
                key={type}
                type="button"
                title={meta.label}
                onClick={() => setFilters((current) => ({
                  ...current,
                  types: { ...current.types, [type]: !current.types[type] },
                }))}
                className={`h-12 rounded-md border flex flex-col items-center justify-center gap-1 transition-colors ${active ? 'bg-white/10' : 'bg-black/20 opacity-45'}`}
                style={{ borderColor: active ? `${meta.color}80` : 'rgba(255,255,255,0.08)' }}
              >
                <Icon className="w-4 h-4" style={{ color: meta.color }} />
                <span className="text-[7px] leading-none font-mono font-bold" style={{ color: active ? meta.color : 'var(--text-muted)' }}>{meta.label}</span>
              </button>
            );
          })}
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="hud-label">CONFIDENCE</span>
            <span className="text-[10px] font-mono text-[var(--cyan-primary)] tabular-nums">{filters.minConfidence}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={filters.minConfidence}
            onChange={(event) => patchFilters({ minConfidence: Number(event.target.value) })}
            className="w-full accent-[var(--cyan-primary)]"
          />
        </div>

        <div>
          <div className="flex items-center gap-1.5 mb-1.5">
            <Clock3 className="w-3 h-3 text-[var(--text-muted)]" />
            <span className="hud-label">WINDOW</span>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {TIME_WINDOWS.map((window) => (
              <button
                key={window.minutes}
                type="button"
                onClick={() => patchFilters({ timeRangeMinutes: window.minutes })}
                className={`h-8 rounded border text-[9px] font-mono font-bold transition-colors ${filters.timeRangeMinutes === window.minutes ? 'border-[var(--gold-primary)]/70 bg-[var(--gold-primary)]/15 text-[var(--gold-primary)]' : 'border-white/10 bg-black/20 text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
              >
                {window.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <div className="flex items-center gap-1.5">
              <MapPin className="w-3 h-3 text-[var(--text-muted)]" />
              <span className="hud-label">BBOX</span>
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                title="Use current map bounds"
                onClick={useMapBounds}
                className="w-7 h-7 rounded border border-[var(--cyan-primary)]/30 bg-[var(--cyan-primary)]/10 flex items-center justify-center hover:bg-[var(--cyan-primary)]/20 disabled:opacity-35"
                disabled={!currentBbox}
              >
                <LocateFixed className="w-3.5 h-3.5 text-[var(--cyan-primary)]" />
              </button>
              <button
                type="button"
                title="Clear bounds"
                onClick={() => patchFilters({ bbox: null })}
                className="w-7 h-7 rounded border border-white/10 bg-black/20 flex items-center justify-center hover:bg-white/10"
              >
                <X className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {(['west', 'south', 'east', 'north'] as const).map((field) => (
              <input
                key={field}
                aria-label={field}
                type="number"
                step="0.01"
                value={filters.bbox ? formatCoord(filters.bbox[field]) : ''}
                placeholder={field.toUpperCase().slice(0, 1)}
                onChange={(event) => patchBbox(field, event.target.value)}
                className="h-8 min-w-0 rounded border border-white/10 bg-black/30 px-1.5 text-[9px] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--cyan-primary)]/60"
              />
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1.5 px-3 py-2 border-b border-[var(--border-secondary)]">
        <div>
          <div className="hud-label">RX</div>
          <div className="hud-value text-[10px]">{streamStats.received.toLocaleString()}</div>
        </div>
        <div>
          <div className="hud-label">BUF</div>
          <div className="hud-value text-[10px]">{streamStats.buffered}</div>
        </div>
        <div>
          <div className="hud-label">MEM</div>
          <div className="hud-value text-[10px]">{streamStats.retained}</div>
        </div>
        <div>
          <div className="hud-label">DROP</div>
          <div className={`hud-value text-[10px] ${streamStats.dropped ? 'text-[var(--alert-orange)]' : ''}`}>{streamStats.dropped}</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto styled-scrollbar">
        {visibleEvents.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <Radio className="w-5 h-5 mx-auto mb-2 text-[var(--text-muted)]" />
            <div className="hud-label">NO MATCHING EVENTS</div>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {visibleEvents.map((event) => {
              const type = getEventType(event);
              const meta = type === 'unknown' ? null : TYPE_META[type];
              const geo = getEventGeo(event);
              const confidence = getEventConfidence(event);
              const eventTime = getEventTimestamp(event);
              const severity = String(event.score?.severity || (event.alert ? 'HIGH' : 'INFO')).toUpperCase();

              return (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => geo && onLocate?.(geo.lat, geo.lon)}
                  className="w-full text-left px-3 py-2.5 hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-start gap-2">
                    <div className="mt-1 w-2 h-2 rounded-full shrink-0" style={{ background: meta?.color || 'var(--text-muted)', boxShadow: `0 0 8px ${meta?.color || 'transparent'}` }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[9px] font-mono font-bold truncate" style={{ color: meta?.color || 'var(--text-primary)' }}>
                          {meta?.label || 'EVENT'}
                        </span>
                        <span className="text-[8px] font-mono text-[var(--text-muted)] shrink-0">{formatTime(eventTime)}</span>
                      </div>
                      <div className="text-[10px] leading-snug text-[var(--text-primary)] truncate mt-0.5">{event.title || `${type.toUpperCase()} observed`}</div>
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
        )}
      </div>
    </div>
  );
}

