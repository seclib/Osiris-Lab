import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
const GDELT_QUERY_TIMEOUT_MS = 4000;
const GDELT_BUDGET_MS = 9000;

/**
 * OSIRIS — Real-Time Geopolitical Events (GDELT 2.0 GeoJSON API)
 * Source: GDELT Project — completely free, no auth required
 * Replaces the old RSS scraper with actual GDELT geo-coded events.
 */

export async function GET() {
  try {
    // GDELT GEO 2.0 API — returns real events with actual coordinates
    const queries = [
      'protest OR riot OR unrest',
      'conflict OR military OR attack OR strike',
      'coup OR revolution OR emergency',
    ];
    
    const allEvents: any[] = [];
    let eventId = 0;
    const deadline = Date.now() + GDELT_BUDGET_MS;

    for (const query of queries) {
      if (Date.now() >= deadline) break;
      try {
        const encodedQuery = encodeURIComponent(query);
        const url = `https://api.gdeltproject.org/api/v2/geo/geo?query=${encodedQuery}&format=GeoJSON&timespan=24h&maxpoints=100`;
        
        const remaining = Math.max(deadline - Date.now(), 1000);
        const timeoutMs = Math.min(GDELT_QUERY_TIMEOUT_MS, remaining);
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
        if (!res.ok) continue;

        const geojson = await res.json();
        if (!geojson?.features) continue;

        for (const feature of geojson.features) {
          const coords = feature.geometry?.coordinates;
          if (!coords || coords.length < 2) continue;

          const props = feature.properties || {};
          const name = props.name || props.html?.replace(/<[^>]*>/g, '').slice(0, 120) || 'GDELT Event';
          const url = props.url || props.shareimage || '';

          // Deduplicate by proximity (within 0.5 degrees)
          const isDupe = allEvents.some(e => 
            Math.abs(e.lat - coords[1]) < 0.5 && Math.abs(e.lng - coords[0]) < 0.5 && e.name === name
          );
          if (isDupe) continue;

          allEvents.push({
            id: `gdelt-${eventId++}`,
            lat: coords[1],
            lng: coords[0],
            name,
            url,
            html: props.html || '',
            type: query.includes('protest') ? 'unrest' : query.includes('conflict') ? 'conflict' : 'political',
            count: props.count || 1,
            shareimage: props.shareimage || '',
          });
        }
      } catch {
        // Individual query failure is non-fatal
      }
    }

    return NextResponse.json({
      events: allEvents,
      total: allEvents.length,
      timestamp: new Date().toISOString(),
      source: 'GDELT 2.0 GeoJSON API',
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  } catch (error) {
    console.error('[OSIRIS] GDELT fetch error:', error);
    return NextResponse.json({ events: [], total: 0, error: 'GDELT unavailable' }, { status: 500 });
  }
}
