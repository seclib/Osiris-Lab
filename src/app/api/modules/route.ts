import { NextResponse } from 'next/server';
import {
  MODULE_CONFIG_SCHEMA,
  clearModuleRuntimeState,
  listModules,
  normalizeModuleId,
  parseBoolean,
  setModuleRuntimeState,
  type ModulePatch,
} from '@/lib/module-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

function actorFromRequest(request: Request) {
  return request.headers.get('x-osiris-actor') || 'api';
}

function patchesFromBody(body: unknown, actor: string): ModulePatch[] {
  if (!body || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;
  const reason = typeof record.reason === 'string' ? record.reason : undefined;
  const updatedBy = typeof record.updatedBy === 'string' ? record.updatedBy : actor;

  if (record.modules && typeof record.modules === 'object') {
    const patches: ModulePatch[] = [];
    for (const [id, value] of Object.entries(record.modules as Record<string, unknown>)) {
      const enabled = typeof value === 'object' && value !== null
        ? parseBoolean((value as Record<string, unknown>).enabled)
        : parseBoolean(value);
      if (enabled === null) continue;
      patches.push({
        id: normalizeModuleId(id),
        enabled,
        updatedBy,
        ...(reason ? { reason } : {}),
      });
    }
    return patches;
  }

  const id = typeof record.id === 'string'
    ? record.id
    : typeof record.module === 'string'
      ? record.module
      : typeof record.module_id === 'string'
        ? record.module_id
        : '';
  const enabled = parseBoolean(record.enabled ?? record.state);

  if (!id || enabled === null) return [];
  return [{
    id: normalizeModuleId(id),
    enabled,
    updatedBy,
    ...(reason ? { reason } : {}),
  }];
}

export async function GET() {
  const modules = await listModules();
  return NextResponse.json({
    modules,
    schema: MODULE_CONFIG_SCHEMA,
    timestamp: new Date().toISOString(),
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function PATCH(request: Request) {
  const denied = adminError(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const patches = patchesFromBody(body, actorFromRequest(request));
  if (patches.length === 0) {
    return NextResponse.json(
      { error: 'Expected {id, enabled} or {modules:{[id]: enabled}}.' },
      { status: 400 },
    );
  }

  try {
    const updated = [];
    for (const patch of patches) {
      updated.push(await setModuleRuntimeState(patch));
    }
    return NextResponse.json({
      updated,
      modules: await listModules(),
      timestamp: new Date().toISOString(),
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Module update failed.' },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request) {
  const denied = adminError(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'Missing id query parameter.' }, { status: 400 });
  }

  try {
    const moduleState = await clearModuleRuntimeState(id);
    return NextResponse.json({
      module: moduleState,
      modules: await listModules(),
      timestamp: new Date().toISOString(),
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Module reset failed.' },
      { status: 400 },
    );
  }
}
