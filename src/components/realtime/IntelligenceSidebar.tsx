'use client';

import type { Dispatch, SetStateAction } from 'react';
import { BrainCircuit, Filter } from 'lucide-react';
import type { CoreBrainStreamStatus } from '@/lib/use-core-brain-stream';
import type { EventBbox, EventFilterState, IntelligenceEvent } from '@/lib/event-stream';
import FilterPanel from '@/components/realtime/FilterPanel';
import LiveEventFeed from '@/components/realtime/LiveEventFeed';

type IntelligenceSidebarProps = {
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

function statusColor(status: CoreBrainStreamStatus): string {
  if (status === 'connected') return 'var(--alert-green)';
  if (status === 'reconnecting' || status === 'connecting') return 'var(--gold-primary)';
  return 'var(--alert-red)';
}

export default function IntelligenceSidebar({
  events,
  filteredEvents,
  filters,
  setFilters,
  streamStatus,
  streamStats,
  currentBbox,
  isMobile = false,
  onLocate,
}: IntelligenceSidebarProps) {
  const latestInsight = filteredEvents.at(-1)?.agent_insight?.summary;

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

      {latestInsight && (
        <div className="px-3 py-2 border-b border-[var(--border-secondary)] bg-[var(--cyan-primary)]/5">
          <div className="flex items-start gap-2">
            <BrainCircuit className="w-3.5 h-3.5 text-[var(--cyan-primary)] shrink-0 mt-0.5" />
            <div className="text-[10px] leading-snug text-[var(--text-primary)]">{latestInsight}</div>
          </div>
        </div>
      )}

      <FilterPanel filters={filters} setFilters={setFilters} currentBbox={currentBbox} />

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
        <LiveEventFeed events={filteredEvents} onLocate={onLocate} />
      </div>
    </div>
  );
}

