import { NextResponse } from 'next/server';
import {
  clearModuleRuntimeState,
  getModuleState,
  normalizeModuleId,
  parseBoolean,
  setModuleRuntimeState,
} from '@/lib/module-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = {
  params: Promise<{
    id: string;
  }>;
};

function adminError(request: Request) {
  const configuredToken = process.env.OSIRIS_MODULE_ADMIN_TOKEN;
  const allowUnauthenticated = parseBoolean(process.env.OSIRIS_MODULE_ALLOW_UNAUTHENTICATED_TOGGLES) === true;

  if (!configuredToken && process.env.NODE_ENV === 'production' && !allowUnauthenticated) {
    return NextResponse.json(
      {
        error: 'Module mutations require OSIRIS_MODULE_ADMIN_TOKEN in production.',
        code: 'MODULE_ADMIN_TOKEN_REQUIRED',
      },
      { status: 503 },
    );
  }

  if (!configuredToken || allowUnauthenticated) return null;

  const auth = request.headers.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const headerToken = request.headers.get('x-osiris-admin-token') || '';
  if (bearer === configuredToken || headerToken === configuredToken) return null;

  return NextResponse.json(
    { error: 'Unauthorized module mutation.', code: 'UNAUTHORIZED_MODULE_ADMIN' },
    { status: 401 },
  );
}

export async function GET(_request: Request, context: Params) {
  const { id } = await context.params;
  const moduleState = await getModuleState(id);
  if (!moduleState) {
    return NextResponse.json({ error: `Unknown module: ${id}` }, { status: 404 });
  }

  return NextResponse.json({ module: moduleState }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function PATCH(request: Request, context: Params) {
  const denied = adminError(request);
  if (denied) return denied;

  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const enabled = parseBoolean(record.enabled ?? record.state);
  if (enabled === null) {
    return NextResponse.json({ error: 'Expected boolean enabled/state.' }, { status: 400 });
  }

  try {
    const moduleState = await setModuleRuntimeState({
      id: normalizeModuleId(id),
      enabled,
      updatedBy: typeof record.updatedBy === 'string' ? record.updatedBy : request.headers.get('x-osiris-actor') || 'api',
      reason: typeof record.reason === 'string' ? record.reason : undefined,
    });
    return NextResponse.json({ module: moduleState, timestamp: new Date().toISOString() }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Module update failed.' },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request, context: Params) {
  const denied = adminError(request);
  if (denied) return denied;

  const { id } = await context.params;
  try {
    const moduleState = await clearModuleRuntimeState(id);
    return NextResponse.json({ module: moduleState, timestamp: new Date().toISOString() }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Module reset failed.' },
      { status: 400 },
    );
  }
}
