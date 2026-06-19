'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Layer configuration
 */
export interface LayerState {
  flights: boolean;
  private: boolean;
  jets: boolean;
  military: boolean;
  maritime: boolean;
  satellites: boolean;
  balloons: boolean;
  cctv: boolean;
  live_news: boolean;
  news_intel: boolean;
  earthquakes: boolean;
  fires: boolean;
  weather: boolean;
  radiation: boolean;
  infrastructure: boolean;
  global_incidents: boolean;
  war_alerts: boolean;
  gps_jamming: boolean;
  day_night: boolean;
  cables: boolean;
  sdk_sea: boolean;
  sdk_air: boolean;
  sdk_naval: boolean;
  terrain_3d: boolean;
  malware: boolean;
}

/**
 * Backend connection status
 */
export type BackendStatus = 'connecting' | 'connected' | 'error';

/**
 * Fetch transform function type
 */
type FetchTransform = (data: Record<string, unknown>) => Record<string, unknown>;

/**
 * Layer fetch configuration
 */
interface LayerFetchConfig {
  key: keyof LayerState;
  url: string;
  transform?: FetchTransform;
}

/**
 * Hook result
 */
export interface UseLayerDataResult {
  dataRef: React.MutableRefObject<Record<string, unknown>>;
  dataVersion: number;
  backendStatus: BackendStatus;
  fetchEndpoint: (url: string, transform?: FetchTransform) => Promise<void>;
}

/**
 * Default layer configuration
 */
const DEFAULT_LAYERS: LayerState = {
  flights: false,
  private: false,
  jets: false,
  military: false,
  maritime: true,
  satellites: false,
  balloons: false,
  cctv: true,
  live_news: true,
  news_intel: true,
  earthquakes: true,
  fires: false,
  weather: false,
  radiation: false,
  infrastructure: false,
  global_incidents: true,
  war_alerts: false,
  gps_jamming: false,
  day_night: true,
  cables: true,
  sdk_sea: true,
  sdk_air: true,
  sdk_naval: true,
  terrain_3d: false,
  malware: false,
};

/**
 * Layer fetch configurations
 */
const LAYER_FETCH_CONFIGS: LayerFetchConfig[] = [
  { key: 'flights', url: '/api/flights' },
  { key: 'satellites', url: '/api/satellites' },
  { key: 'fires', url: '/api/fires' },
  { key: 'cctv', url: '/api/cctv?region=all&v=2' },
  {
    key: 'maritime',
    url: '/api/maritime',
    transform: (d: Record<string, unknown>) => ({
      maritime_ports: d.ports as unknown[],
      maritime_chokepoints: d.chokepoints as unknown[],
      maritime_ships: d.ships as unknown[],
    }),
  },
  {
    key: 'balloons',
    url: '/api/balloons',
    transform: (d: Record<string, unknown>) => ({ balloons: d.balloons as unknown[] }),
  },
  {
    key: 'radiation',
    url: '/api/radiation',
    transform: (d: Record<string, unknown>) => ({ radiation: d.stations as unknown[] }),
  },
  {
    key: 'live_news',
    url: '/api/live-news',
    transform: (d: Record<string, unknown>) => ({ live_feeds: d.feeds as unknown[] }),
  },
  {
    key: 'weather',
    url: '/api/weather',
    transform: (d: Record<string, unknown>) => ({ weather_events: d.events as unknown[] }),
  },
  {
    key: 'infrastructure',
    url: '/api/infrastructure',
    transform: (d: Record<string, unknown>) => ({ infrastructure: d.infrastructure as unknown[] }),
  },
  {
    key: 'global_incidents',
    url: '/api/gdelt',
    transform: (d: Record<string, unknown>) => ({ gdelt: d.events as unknown[] }),
  },
  {
    key: 'malware',
    url: '/api/malware',
    transform: (d: Record<string, unknown>) => ({ malware_threats: d.threats as unknown[] }),
  },
];

/**
 * Hook for managing layer data fetching
 * 
 * @param activeLayers - Current layer state
 * @returns Data reference, version, status, and fetch utility
 */
export function useLayerData(
  activeLayers: LayerState = DEFAULT_LAYERS
): UseLayerDataResult {
  const dataRef = useRef<Record<string, unknown>>({});
  const [dataVersion, setDataVersion] = useState(0);
  const [backendStatus, setBackendStatus] = useState<BackendStatus>('connecting');
  const layerFetchedRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  // Track mount state
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchEndpoint = useCallback(async (url: string, transform?: FetchTransform) => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      const d = transform ? transform(json) : json;
      if (mountedRef.current) {
        dataRef.current = { ...dataRef.current, ...d };
        setDataVersion((v) => v + 1);
        setBackendStatus('connected');
      }
    } catch {
      if (mountedRef.current) {
        setBackendStatus('error');
      }
    }
  }, []);

  // Initial data load — wrapped in a single effect to avoid cascading
  useEffect(() => {
    const initialLoad = async () => {
      await Promise.all([
        fetchEndpoint('/api/earthquakes'),
        fetchEndpoint('/api/news'),
        fetchEndpoint('/api/stats'),
      ]);
    };
    initialLoad();
  }, [fetchEndpoint]);

  // Layer-aware data loading
  useEffect(() => {
    for (const cfg of LAYER_FETCH_CONFIGS) {
      const isActive = activeLayers[cfg.key];
      if (isActive && !layerFetchedRef.current.has(cfg.key)) {
        fetchEndpoint(cfg.url, cfg.transform);
        layerFetchedRef.current.add(cfg.key);
      }
    }
  }, [activeLayers, fetchEndpoint]);

  return { dataRef, dataVersion, backendStatus, fetchEndpoint };
}

export { DEFAULT_LAYERS };