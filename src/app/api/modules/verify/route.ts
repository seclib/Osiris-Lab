import { NextResponse } from 'next/server';
import {
  verificationArchitecture,
  verifyModules,
  type VerifyModulesOptions,
} from '@/lib/module-verifier';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type VerifyRequestBody = {
  moduleId?: string;
  module?: string;
  includeDisabled?: boolean;
  retries?: number;
  timeoutMs?: number;
  strict?: boolean;
};

function parseBoolean(value: string | null) {
  if (value === null) return false;
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

function optionsFromRequest(request: Request, body?: VerifyRequestBody): VerifyModulesOptions & { strict: boolean } {
  const url = new URL(request.url);
  const moduleId = body?.moduleId || body?.module || url.searchParams.get('module') || undefined;
  const includeDisabled = body?.includeDisabled ?? parseBoolean(url.searchParams.get('includeDisabled'));
  const strict = body?.strict ?? parseBoolean(url.searchParams.get('strict'));
  const retries = parsePositiveInt(body?.retries ?? url.searchParams.get('retries'), 1);
  const timeoutMs = parsePositiveInt(body?.timeoutMs ?? url.searchParams.get('timeoutMs'), 8000);

  return {
    baseUrl: baseUrlFor(request),
    moduleId,
    includeDisabled,
    retries,
    timeoutMs,
    strict,
  };
}

async function runVerification(request: Request, body?: VerifyRequestBody) {
  const { strict, ...options } = optionsFromRequest(request, body);
  const report = await verifyModules(options);
  const httpStatus = strict && report.status !== 'OK' ? 503 : 200;

  return NextResponse.json({
    ...report,
    architecture: verificationArchitecture(),
    strict,
  }, {
    status: httpStatus,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: Request) {
  return runVerification(request);
}

export async function POST(request: Request) {
  let body: VerifyRequestBody | undefined;
  try {
    body = await request.json() as VerifyRequestBody;
  } catch {
    body = undefined;
  }

  return runVerification(request, body);
}
