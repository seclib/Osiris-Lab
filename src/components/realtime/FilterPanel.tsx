'use client';

import type { Dispatch, SetStateAction } from 'react';
import { Activity, Clock3, CloudLightning, Flame, LocateFixed, MapPin, Plane, Ship, X } from 'lucide-react';
import {
  EVENT_TYPES,
  type EventBbox,
  type EventFilterState,
  type EventType,
} from '@/lib/event-stream';

type FilterPanelProps = {
  filters: EventFilterState;
  setFilters: Dispatch<SetStateAction<EventFilterState>>;
  currentBbox: EventBbox | null;
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

function formatCoord(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '';
}

export default function FilterPanel({ filters, setFilters, currentBbox }: FilterPanelProps) {
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

  return (
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
              onClick={() => currentBbox && patchFilters({ bbox: currentBbox })}
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
  );
}

