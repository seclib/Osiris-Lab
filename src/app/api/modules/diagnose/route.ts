import { NextResponse } from 'next/server';
import { runModuleDebugging, type DebugModuleId } from '@/lib/module-debugger';
import type { VerifyModulesOptions } from '@/lib/module-verifier';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type DiagnoseRequestBody = {
  module?: DebugModuleId;
  moduleId?: DebugModuleId;
  retries?: number;
  timeoutMs?: number;
  strict?: boolean;
};

function parseBoolean(value: string | null) {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parsePositiveInt(value: unknown, fallback: number) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

function baseUrlFor(request: Request) {
  return process.env.OSIRIS_INTERNAL_BASE_URL || new URL(request.url).origin;
}

function optionsFromRequest(request: Request, body?: DiagnoseRequestBody): VerifyModulesOptions & { strict: boolean } {
  const url = new URL(request.url);
  const moduleId = body?.moduleId || body?.module || url.searchParams.get('module') || undefined;
  const retries = parsePositiveInt(body?.retries ?? url.searchParams.get('retries'), 1);
  const timeoutMs = parsePositiveInt(body?.timeoutMs ?? url.searchParams.get('timeoutMs'), 8000);
  const strict = body?.strict ?? parseBoolean(url.searchParams.get('strict'));

  return {
    baseUrl: baseUrlFor(request),
    moduleId,
    includeDisabled: true,
    retries,
    timeoutMs,
    strict,
  };
}

async function runDiagnosis(request: Request, body?: DiagnoseRequestBody) {
  const { strict, ...options } = optionsFromRequest(request, body);
  const report = await runModuleDebugging(options);
  const httpStatus = strict && report.status !== 'STABLE' ? 503 : 200;

  return NextResponse.json({
    ...report,
    strict,
  }, {
    status: httpStatus,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: Request) {
  return runDiagnosis(request);
}

export async function POST(request: Request) {
  let body: DiagnoseRequestBody | undefined;
  try {
    body = await request.json() as DiagnoseRequestBody;
  } catch {
    body = undefined;
  }

  return runDiagnosis(request, body);
}
