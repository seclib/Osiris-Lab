import { NextResponse } from 'next/server';
import { disabledModulePayload, getModuleState } from '@/lib/module-registry';

export async function GET(req: Request) {
  const moduleState = await getModuleState('shodan');
  if (moduleState && !moduleState.enabled) {
    return NextResponse.json(await disabledModulePayload('shodan', {
      error: 'Shodan module disabled',
      ports: [],
      cpes: [],
      hostnames: [],
      tags: [],
      vulns: [],
    }), {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const { searchParams } = new URL(req.url);
  const ip = searchParams.get('ip');

  if (!ip) {
    return NextResponse.json({ error: 'Missing IP parameter' }, { status: 400 });
  }

  try {
    const res = await fetch(`https://internetdb.shodan.io/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store'
    });

    if (res.status === 404) {
      return NextResponse.json({
        ip,
        status: 'No Shodan InternetDB records found',
        ports: [],
        cpes: [],
        hostnames: [],
        tags: [],
        vulns: []
      });
    }

    if (!res.ok) {
      throw new Error(`Shodan HTTP ${res.status}`);
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({
      error: 'Shodan lookup failed',
      detail: error instanceof Error ? error.message : String(error),
    }, { status: 502 });
  }
}
