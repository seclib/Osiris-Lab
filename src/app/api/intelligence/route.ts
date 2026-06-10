import { NextResponse } from 'next/server';
import {
  generateIntelligenceReport,
  type FeedStatus,
  type OperationalData,
} from '@/lib/intelligence-engine';
import { disabledModulePayload, getModuleState } from '@/lib/module-registry';

export const dynamic = 'force-dynamic';

type FeedSpec = {
  module: keyof OperationalData;
  path: string;
  pick: (payload: unknown) => Partial<OperationalData>;
};

const FEEDS: FeedSpec[] = [
  {
    module: 'earthquakes',
    path: '/api/earthquakes',
    pick: payload => ({ earthquakes: arrayFrom(payload, 'earthquakes') }),
  },
  {
    module: 'news',
    path: '/api/news',
    pick: payload => ({ news: arrayFrom(payload, 'news') }),
  },
  {
    module: 'gdelt',
    path: '/api/gdelt',
    pick: payload => ({ gdelt: arrayFrom(payload, 'events') }),
  },
  {
    module: 'weather_events',
    path: '/api/weather',
    pick: payload => ({ weather_events: arrayFrom(payload, 'events') }),
  },
  {
    module: 'fires',
    path: '/api/fires',
    pick: payload => ({ fires: arrayFrom(payload, 'fires') }),
  },
  {
    module: 'maritime_ships',
    path: '/api/maritime',
    pick: payload => ({
      maritime_ports: arrayFrom(payload, 'ports'),
      maritime_chokepoints: arrayFrom(payload, 'chokepoints'),
      maritime_ships: arrayFrom(payload, 'ships'),
    }),
  },
  {
    module: 'military_flights',
    path: '/api/flights',
    pick: payload => ({
      commercial_flights: arrayFrom(payload, 'commercial_flights'),
      private_flights: arrayFrom(payload, 'private_flights'),
      private_jets: arrayFrom(payload, 'private_jets'),
      military_flights: arrayFrom(payload, 'military_flights'),
      gps_jamming: arrayFrom(payload, 'gps_jamming'),
    }),
  },
  {
    module: 'satellites',
    path: '/api/satellites',
    pick: payload => ({ satellites: arrayFrom(payload, 'satellites') }),
  },
  {
    module: 'cyber_threats',
    path: '/api/cyber-threats',
    pick: payload => ({ cyber_threats: arrayFrom(payload, 'threats') }),
  },
  {
    module: 'malware_threats',
    path: '/api/malware',
    pick: payload => ({ malware_threats: arrayFrom(payload, 'threats') }),
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function arrayFrom(payload: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(payload)) return [];
  const value = payload[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function internalBaseUrl(): string {
  return process.env.OSIRIS_INTERNAL_BASE_URL || `http://127.0.0.1:${process.env.PORT || '3000'}`;
}

async function fetchFeed(spec: FeedSpec, baseUrl: string): Promise<{
  data: Partial<OperationalData>;
  status: FeedStatus;
}> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(`${baseUrl}${spec.path}`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        data: {},
        status: {
          module: String(spec.module),
          ok: false,
          status: 'DEGRADED',
          latencyMs,
          error: `http_${res.status}`,
        },
      };
    }

    const payload = await res.json() as unknown;
    return {
      data: spec.pick(payload),
      status: {
        module: String(spec.module),
        ok: true,
        status: 'OK',
        latencyMs,
      },
    };
  } catch (error) {
    return {
      data: {},
      status: {
        module: String(spec.module),
        ok: false,
        status: 'OFFLINE',
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET() {
  const moduleState = await getModuleState('intelligence');
  if (moduleState && !moduleState.enabled) {
    return NextResponse.json(await disabledModulePayload('intelligence', {
      generated_at: new Date().toISOString(),
      summary: {
        total_findings: 0,
        critical: 0,
        high: 0,
        elevated: 0,
        modules: [],
      },
      module_summaries: [],
      findings: [],
      feed_status: [],
    }), {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }

  const baseUrl = internalBaseUrl();
  const results = await Promise.all(FEEDS.map(feed => fetchFeed(feed, baseUrl)));

  const data = results.reduce<OperationalData>((acc, result) => ({
    ...acc,
    ...result.data,
  }), {
    feed_status: results.map(result => result.status),
  });

  const report = generateIntelligenceReport(data);
  return NextResponse.json(report, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
