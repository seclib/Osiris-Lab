import { NextResponse } from 'next/server';

const STATS_FETCH_TIMEOUT_MS = 5000;

function fetchWithTimeout(url: string, init: RequestInit = {}) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(STATS_FETCH_TIMEOUT_MS),
  });
}

/**
 * OSIRIS — Global Stats API
 * Lightweight aggregation endpoint.
 * Fetches metrics from all local APIs and returns ONLY the counts.
 * 
 * ARCHITECTURE NOTE (10k+ Concurrent Users):
 * This endpoint ensures the Next.js server serves ~100 bytes instead of 10MB+ 
 * of raw GeoJSON mapping data when 10,000 users boot the dashboard simultaneously.
 * The underlying API routes utilize their own 45-60s TTL caching, meaning the 
 * heavy external APIs (adsb.lol, USGS) are only hit once per minute, while this 
 * lightweight stats route safely serves 10k concurrent users instantly.
 */

export async function GET(req: Request) {
  try {
    const origin = new URL(req.url).origin;

    // Fetch all internal APIs in parallel (they have their own Cache-Control TTLs)
    const [flightsRes, satsRes, cctvRes, weatherRes, infraRes, gdeltRes] = await Promise.allSettled([
      fetchWithTimeout(`${origin}/api/flights`, { next: { revalidate: 45 } }),
      fetchWithTimeout(`${origin}/api/satellites`, { next: { revalidate: 3600 } }),
      fetchWithTimeout(`${origin}/api/cctv?lat=42.70&lng=25.48&radius=8`, { next: { revalidate: 3600 } }),
      fetchWithTimeout(`${origin}/api/weather`, { next: { revalidate: 300 } }),
      fetchWithTimeout(`${origin}/api/infrastructure`, { next: { revalidate: 86400 } }),
      fetchWithTimeout(`${origin}/api/gdelt`, { next: { revalidate: 300 } })
    ]);

    let flights = 0;
    let sats = 0;
    let cctv = 0;
    let weather = 0;
    let nuclear = 0;
    let incidents = 0;

    // Safely parse counts
    if (flightsRes.status === 'fulfilled' && flightsRes.value.ok) {
      const data = await flightsRes.value.json();
      flights = (data.commercial_flights?.length || 0) + 
                (data.private_flights?.length || 0) + 
                (data.private_jets?.length || 0) + 
                (data.military_flights?.length || 0);
    }

    if (satsRes.status === 'fulfilled' && satsRes.value.ok) {
      const data = await satsRes.value.json();
      sats = data.satellites?.length || 0;
    }

    if (cctvRes.status === 'fulfilled' && cctvRes.value.ok) {
      const data = await cctvRes.value.json();
      cctv = data.cameras?.length || 0;
    }

    if (weatherRes.status === 'fulfilled' && weatherRes.value.ok) {
      const data = await weatherRes.value.json();
      weather = data.events?.length || data.weather_events?.length || 0;
    }

    if (infraRes.status === 'fulfilled' && infraRes.value.ok) {
      const data = await infraRes.value.json();
      nuclear = data.infrastructure?.length || 0;
    }

    if (gdeltRes.status === 'fulfilled' && gdeltRes.value.ok) {
        const data = await gdeltRes.value.json();
        incidents = data.events?.length || data.gdelt?.length || 0;
    }

    return NextResponse.json({
      stats: {
        flights,
        sats,
        cctv,
        weather,
        nuclear,
        incidents
      },
      timestamp: new Date().toISOString()
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
      }
    });

  } catch (error) {
    console.error('Stats aggregation failed:', error);
    return NextResponse.json({ error: 'Failed to compute stats' }, { status: 500 });
  }
}
