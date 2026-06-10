import { listModules, type ResolvedModule } from '@/lib/module-registry';

export type VerificationStatus = 'OK' | 'DEGRADED' | 'OFFLINE' | 'DISABLED';
export type AlertSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AlertType =
  | 'module_disabled'
  | 'api_unreachable'
  | 'runtime_error'
  | 'schema_invalid'
  | 'data_stale'
  | 'empty_data'
  | 'latency_high';

export type ModuleVerificationAlert = {
  id: string;
  moduleId: string;
  severity: AlertSeverity;
  type: AlertType;
  message: string;
  action: string;
  generatedAt: string;
};

export type ModuleVerificationCheck = {
  moduleId: string;
  name: string;
  kind: string;
  enabled: boolean;
  state: ResolvedModule['state'];
  endpoint?: string;
  url?: string;
  status: VerificationStatus;
  httpStatus?: number;
  latencyMs?: number;
  attempts: number;
  format: {
    ok: boolean;
    expected: string[];
    observed: string[];
  };
  freshness: {
    ok: boolean;
    observedAt?: string | null;
    ageSeconds?: number | null;
    maxAgeSeconds?: number;
    reason?: string;
  };
  counts: Record<string, number>;
  warnings: string[];
  errors: string[];
  alerts: ModuleVerificationAlert[];
};

export type ModuleVerificationReport = {
  status: Exclude<VerificationStatus, 'DISABLED'>;
  summary: {
    total: number;
    enabled: number;
    disabled: number;
    ok: number;
    degraded: number;
    offline: number;
    alerts: number;
    latencyP95Ms: number;
  };
  checks: ModuleVerificationCheck[];
  alerts: ModuleVerificationAlert[];
  generatedAt: string;
};

export type VerifyModulesOptions = {
  baseUrl: string;
  moduleId?: string;
  includeDisabled?: boolean;
  retries?: number;
  timeoutMs?: number;
  now?: Date;
};

type ModuleValidationRule = {
  path?: string;
  expectedArrays?: string[];
  expectedObjects?: string[];
  timestampKeys?: string[];
  freshnessSeconds: number;
  staleItemKeys?: string[];
  emptyDataIsDegraded?: boolean;
  latencyWarningMs?: number;
  buildPath?: () => string;
  custom?: (payload: Record<string, unknown>, now: Date) => Partial<ModuleVerificationCheck>;
};

type FetchAttempt = {
  ok: boolean;
  httpStatus?: number;
  latencyMs: number;
  payload?: unknown;
  error?: string;
};

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 1;

const MODULE_RULES: Record<string, ModuleValidationRule> = {
  ais: {
    expectedArrays: ['ports', 'chokepoints', 'ships'],
    expectedObjects: ['freshness'],
    timestampKeys: ['timestamp'],
    freshnessSeconds: 180,
    staleItemKeys: ['timestamp', 'last_seen', 'lastSeen'],
    emptyDataIsDegraded: true,
    latencyWarningMs: 2500,
    custom: (payload) => {
      const freshness = recordAt(payload, 'freshness');
      const aisstream = recordAt(freshness, 'aisstream');
      const vesselApi = recordAt(freshness, 'vessel_api');
      const configured = Boolean(aisstream?.configured || vesselApi?.configured);
      const errors = configured ? [] : ['no_ais_upstream_configured'];
      const warnings = configured ? [] : ['AIS module is enabled but no AIS/Vessel API source is configured.'];
      const age = numberAt(freshness, 'newest_ship_age_seconds');
      return {
        warnings,
        errors,
        freshness: {
          ok: age === null || age <= 900,
          ageSeconds: age,
          maxAgeSeconds: 900,
          reason: age !== null && age > 900 ? 'newest_ship_stale' : undefined,
        },
      };
    },
  },
  adsb: {
    expectedArrays: ['commercial_flights', 'private_flights', 'private_jets', 'military_flights', 'gps_jamming'],
    timestampKeys: ['timestamp'],
    freshnessSeconds: 120,
    emptyDataIsDegraded: true,
    latencyWarningMs: 3500,
  },
  earthquakes: {
    expectedArrays: ['earthquakes'],
    timestampKeys: ['timestamp'],
    freshnessSeconds: 600,
    staleItemKeys: ['time'],
    latencyWarningMs: 2500,
  },
  wildfires: {
    expectedArrays: ['fires'],
    timestampKeys: ['timestamp'],
    freshnessSeconds: 1800,
    emptyDataIsDegraded: true,
    latencyWarningMs: 5000,
  },
  satellites: {
    expectedArrays: ['satellites'],
    timestampKeys: ['timestamp'],
    freshnessSeconds: 900,
    emptyDataIsDegraded: true,
    latencyWarningMs: 5000,
    custom: (payload) => ({
      warnings: payload.degraded === true ? ['satellite_provider_degraded'] : [],
      errors: payload.error ? [String(payload.error)] : [],
    }),
  },
  shodan: {
    buildPath: () => `/api/osint/shodan?ip=${encodeURIComponent(process.env.SHODAN_VERIFY_IP || '1.1.1.1')}`,
    expectedArrays: ['ports', 'cpes', 'hostnames', 'tags', 'vulns'],
    freshnessSeconds: 604800,
    latencyWarningMs: 2500,
  },
  intelligence: {
    expectedArrays: ['findings', 'module_summaries', 'feed_status'],
    expectedObjects: ['summary'],
    timestampKeys: ['generated_at', 'timestamp'],
    freshnessSeconds: 300,
    latencyWarningMs: 5000,
  },
  cctv: {
    expectedArrays: ['cameras'],
    expectedObjects: ['sources'],
    timestampKeys: ['timestamp'],
    freshnessSeconds: 3600,
    latencyWarningMs: 5000,
  },
  news: {
    expectedArrays: ['news'],
    expectedObjects: ['providers'],
    timestampKeys: ['timestamp'],
    freshnessSeconds: 900,
    staleItemKeys: ['published', 'pubDate', 'date'],
    emptyDataIsDegraded: true,
    latencyWarningMs: 3500,
  },
  weather: {
    expectedArrays: ['events'],
    timestampKeys: ['timestamp'],
    freshnessSeconds: 900,
    latencyWarningMs: 3500,
  },
  cyber: {
    expectedArrays: ['threats'],
    expectedObjects: ['stats'],
    timestampKeys: ['timestamp'],
    freshnessSeconds: 3600,
    latencyWarningMs: 3500,
  },
};

export function verificationArchitecture() {
  return {
    architecture: [
      'Module registry resolves env/json/runtime enabled state.',
      'Verifier fetches each enabled module endpoint after deployment.',
      'Validator checks HTTP reachability, JSON schema, runtime errors, latency, stale timestamps, and empty critical datasets.',
      'Alert generator emits severity-ranked module alerts for deployment gates and monitoring.',
      'Health monitor can call /api/modules/verify?strict=true as an optional deep probe.',
    ],
    pipeline: [
      'discover modules',
      'skip disabled modules unless includeDisabled=true',
      'fetch endpoint with timeout and retry/backoff',
      'validate response schema and module-specific freshness',
      'classify OK/DEGRADED/OFFLINE',
      'emit alerts and deployment-ready summary',
    ],
    retry: {
      defaultRetries: DEFAULT_RETRIES,
      backoff: '200ms * attempt',
      fallback: 'serve module-specific stale/empty disabled-safe payloads from feed APIs; verifier records degraded/offline instead of crashing',
    },
  };
}

export async function verifyModules(options: VerifyModulesOptions): Promise<ModuleVerificationReport> {
  const now = options.now || new Date();
  const moduleId = options.moduleId?.trim().toLowerCase();
  const modules = (await listModules())
    .filter((module) => !moduleId || module.id === moduleId);

  const checks = await Promise.all(modules.map((module) => verifyModule(module, {
    ...options,
    now,
  })));
  const visibleChecks = options.includeDisabled ? checks : checks.filter((check) => check.status !== 'DISABLED');
  const alerts = visibleChecks.flatMap((check) => check.alerts);
  const latencies = visibleChecks
    .map((check) => check.latencyMs)
    .filter((value): value is number => typeof value === 'number')
    .sort((a, b) => a - b);
  const offline = visibleChecks.filter((check) => check.status === 'OFFLINE').length;
  const degraded = visibleChecks.filter((check) => check.status === 'DEGRADED').length;
  const ok = visibleChecks.filter((check) => check.status === 'OK').length;

  return {
    status: offline > 0 ? 'OFFLINE' : degraded > 0 ? 'DEGRADED' : 'OK',
    summary: {
      total: checks.length,
      enabled: checks.filter((check) => check.enabled).length,
      disabled: checks.filter((check) => !check.enabled).length,
      ok,
      degraded,
      offline,
      alerts: alerts.length,
      latencyP95Ms: percentile(latencies, 0.95),
    },
    checks: visibleChecks,
    alerts: alerts.sort((a, b) => severityRank(b.severity) - severityRank(a.severity)),
    generatedAt: now.toISOString(),
  };
}

async function verifyModule(module: ResolvedModule, options: VerifyModulesOptions & { now: Date }): Promise<ModuleVerificationCheck> {
  const rule = MODULE_RULES[module.id] || {
    expectedArrays: [],
    timestampKeys: ['timestamp'],
    freshnessSeconds: 900,
  };

  const baseCheck = emptyCheck(module, rule);
  if (!module.enabled) {
    return {
      ...baseCheck,
      status: 'DISABLED',
      alerts: [
        alertFor(module.id, 'LOW', 'module_disabled', 'Module is disabled by configuration/runtime state.', 'No action required unless this module should be live.', options.now),
      ],
    };
  }

  if (!module.endpoint && !rule.path && !rule.buildPath) {
    const errors = ['missing_endpoint'];
    return finalizeCheck({
      ...baseCheck,
      status: 'OFFLINE',
      errors,
    }, module, rule, options.now);
  }

  const path = rule.buildPath ? rule.buildPath() : rule.path || module.endpoint || '';
  const url = new URL(path, normalizeBaseUrl(options.baseUrl)).toString();
  const fetchResult = await fetchWithRetries(url, {
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    retries: options.retries ?? DEFAULT_RETRIES,
  });

  const check: ModuleVerificationCheck = {
    ...baseCheck,
    url,
    httpStatus: fetchResult.httpStatus,
    latencyMs: fetchResult.latencyMs,
    attempts: fetchResult.attempts,
  };

  if (!fetchResult.ok) {
    return finalizeCheck({
      ...check,
      status: 'OFFLINE',
      errors: [fetchResult.error || `http_${fetchResult.httpStatus || 'unknown'}`],
    }, module, rule, options.now);
  }

  if (!isRecord(fetchResult.payload)) {
    return finalizeCheck({
      ...check,
      status: 'DEGRADED',
      errors: ['response_not_json_object'],
    }, module, rule, options.now);
  }

  const payload = fetchResult.payload;
  const format = validateFormat(payload, rule);
  const counts = collectCounts(payload, rule);
  const freshness = validateFreshness(payload, rule, options.now);
  const runtimeErrors = runtimeErrorsFromPayload(payload);
  const emptyWarnings = emptyWarningsFor(rule, counts);
  const custom = rule.custom ? rule.custom(payload, options.now) : {};

  return finalizeCheck({
    ...check,
    format,
    counts,
    freshness: mergeFreshness(freshness, custom.freshness),
    warnings: [
      ...emptyWarnings,
      ...(custom.warnings || []),
    ],
    errors: [
      ...runtimeErrors,
      ...(custom.errors || []),
    ],
  }, module, rule, options.now);
}

function emptyCheck(module: ResolvedModule, rule: ModuleValidationRule): ModuleVerificationCheck {
  return {
    moduleId: module.id,
    name: module.name,
    kind: module.kind,
    enabled: module.enabled,
    state: module.state,
    endpoint: module.endpoint,
    status: 'OK',
    attempts: 0,
    format: {
      ok: true,
      expected: expectedKeys(rule),
      observed: [],
    },
    freshness: {
      ok: true,
      maxAgeSeconds: rule.freshnessSeconds,
    },
    counts: {},
    warnings: [],
    errors: [],
    alerts: [],
  };
}

function finalizeCheck(
  check: ModuleVerificationCheck,
  module: ResolvedModule,
  rule: ModuleValidationRule,
  now: Date,
): ModuleVerificationCheck {
  const warnings = [...check.warnings];
  const errors = [...check.errors];

  if (!check.format.ok) errors.push('schema_invalid');
  if (!check.freshness.ok) warnings.push(check.freshness.reason || 'data_stale');
  if (check.latencyMs !== undefined && check.latencyMs > (rule.latencyWarningMs || 3000)) {
    warnings.push(`latency_high:${check.latencyMs}ms`);
  }

  const dedupedWarnings = unique(warnings);
  const dedupedErrors = unique(errors);
  let status: VerificationStatus = check.status;
  if (status === 'OK') {
    status = dedupedErrors.length > 0 ? 'DEGRADED' : dedupedWarnings.length > 0 ? 'DEGRADED' : 'OK';
  }
  if (check.status === 'OFFLINE') status = 'OFFLINE';

  const alerts = buildAlerts({
    ...check,
    status,
    warnings: dedupedWarnings,
    errors: dedupedErrors,
  }, module, now);

  return {
    ...check,
    status,
    warnings: dedupedWarnings,
    errors: dedupedErrors,
    alerts,
  };
}

async function fetchWithRetries(url: string, options: { timeoutMs: number; retries: number }): Promise<FetchAttempt & { attempts: number }> {
  let last: FetchAttempt | null = null;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    if (attempt > 0) await sleep(200 * attempt);
    last = await fetchOnce(url, options.timeoutMs);
    if (last.ok) return { ...last, attempts: attempt + 1 };
  }
  return { ...(last || { ok: false, latencyMs: 0, error: 'not_attempted' }), attempts: options.retries + 1 };
}

async function fetchOnce(url: string, timeoutMs: number): Promise<FetchAttempt> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      return { ok: false, httpStatus: res.status, latencyMs, error: 'invalid_json' };
    }

    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        latencyMs,
        payload,
        error: isRecord(payload) && typeof payload.error === 'string' ? payload.error : `http_${res.status}`,
      };
    }

    return { ok: true, httpStatus: res.status, latencyMs, payload };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function validateFormat(payload: Record<string, unknown>, rule: ModuleValidationRule): ModuleVerificationCheck['format'] {
  const expected = expectedKeys(rule);
  const observed = Object.keys(payload).sort();
  const arraysOk = (rule.expectedArrays || []).every((key) => Array.isArray(payload[key]));
  const objectsOk = (rule.expectedObjects || []).every((key) => isRecord(payload[key]));
  return {
    ok: arraysOk && objectsOk,
    expected,
    observed,
  };
}

function collectCounts(payload: Record<string, unknown>, rule: ModuleValidationRule) {
  const counts: Record<string, number> = {};
  for (const key of rule.expectedArrays || []) {
    const value = payload[key];
    counts[key] = Array.isArray(value) ? value.length : 0;
  }
  return counts;
}

function validateFreshness(payload: Record<string, unknown>, rule: ModuleValidationRule, now: Date): ModuleVerificationCheck['freshness'] {
  const observedAt = firstTimestamp(payload, rule.timestampKeys || []);
  if (observedAt) {
    const ageSeconds = Math.max(0, Math.round((now.getTime() - observedAt.getTime()) / 1000));
    return {
      ok: ageSeconds <= rule.freshnessSeconds,
      observedAt: observedAt.toISOString(),
      ageSeconds,
      maxAgeSeconds: rule.freshnessSeconds,
      reason: ageSeconds > rule.freshnessSeconds ? 'endpoint_timestamp_stale' : undefined,
    };
  }

  const itemObservedAt = newestItemTimestamp(payload, rule);
  if (itemObservedAt) {
    const ageSeconds = Math.max(0, Math.round((now.getTime() - itemObservedAt.getTime()) / 1000));
    return {
      ok: ageSeconds <= rule.freshnessSeconds,
      observedAt: itemObservedAt.toISOString(),
      ageSeconds,
      maxAgeSeconds: rule.freshnessSeconds,
      reason: ageSeconds > rule.freshnessSeconds ? 'item_timestamp_stale' : undefined,
    };
  }

  return {
    ok: true,
    observedAt: null,
    ageSeconds: null,
    maxAgeSeconds: rule.freshnessSeconds,
    reason: 'no_timestamp_available',
  };
}

function mergeFreshness(
  base: ModuleVerificationCheck['freshness'],
  override?: Partial<ModuleVerificationCheck['freshness']>,
): ModuleVerificationCheck['freshness'] {
  if (!override) return base;
  return {
    ...base,
    ...override,
    ok: override.ok ?? base.ok,
  };
}

function runtimeErrorsFromPayload(payload: Record<string, unknown>) {
  const errors: string[] = [];
  if (typeof payload.error === 'string' && !payload.disabled) errors.push(payload.error);
  if (payload.degraded === true) errors.push('payload_degraded');
  return errors;
}

function emptyWarningsFor(rule: ModuleValidationRule, counts: Record<string, number>) {
  if (!rule.emptyDataIsDegraded) return [];
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return total === 0 ? ['empty_data'] : [];
}

function buildAlerts(check: ModuleVerificationCheck, module: ResolvedModule, now: Date): ModuleVerificationAlert[] {
  const alerts: ModuleVerificationAlert[] = [];

  if (check.status === 'OFFLINE') {
    alerts.push(alertFor(module.id, 'CRITICAL', 'api_unreachable', `${module.name} API is unreachable.`, 'Restart collector or rollback deployment; check Docker DNS, ports, and upstream credentials.', now));
  }

  for (const error of check.errors) {
    const type: AlertType = error === 'schema_invalid' ? 'schema_invalid' : error.includes('schema') ? 'schema_invalid' : 'runtime_error';
    alerts.push(alertFor(module.id, type === 'schema_invalid' ? 'HIGH' : 'HIGH', type, `${module.name} verification error: ${error}.`, 'Inspect service logs and response payload; keep serving cached/stale-safe data until fixed.', now));
  }

  for (const warning of check.warnings) {
    let type: AlertType = 'runtime_error';
    let severity: AlertSeverity = 'MEDIUM';
    let action = 'Inspect module telemetry and upstream provider health.';
    if (warning.includes('stale')) {
      type = 'data_stale';
      action = 'Check collector refresh loop, upstream API limits, and Redis/cache freshness.';
    } else if (warning.includes('empty_data')) {
      type = 'empty_data';
      action = 'Confirm upstream source is reachable and parser still matches provider schema.';
    } else if (warning.includes('latency_high')) {
      type = 'latency_high';
      severity = 'LOW';
      action = 'Review endpoint fan-out, cache hit rate, and provider latency.';
    }
    alerts.push(alertFor(module.id, severity, type, `${module.name} warning: ${warning}.`, action, now));
  }

  return dedupeAlerts(alerts);
}

function alertFor(moduleId: string, severity: AlertSeverity, type: AlertType, message: string, action: string, now: Date): ModuleVerificationAlert {
  return {
    id: `${moduleId}:${type}:${severity}`,
    moduleId,
    severity,
    type,
    message,
    action,
    generatedAt: now.toISOString(),
  };
}

function expectedKeys(rule: ModuleValidationRule) {
  return [...(rule.expectedArrays || []), ...(rule.expectedObjects || [])].sort();
}

function firstTimestamp(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const parsed = parseTimestamp(payload[key]);
    if (parsed) return parsed;
  }
  return null;
}

function newestItemTimestamp(payload: Record<string, unknown>, rule: ModuleValidationRule) {
  const keys = rule.staleItemKeys || [];
  if (keys.length === 0) return null;

  let newest: Date | null = null;
  for (const arrayKey of rule.expectedArrays || []) {
    const items = payload[arrayKey];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!isRecord(item)) continue;
      for (const key of keys) {
        const parsed = parseTimestamp(item[key]);
        if (parsed && (!newest || parsed.getTime() > newest.getTime())) newest = parsed;
      }
    }
  }
  return newest;
}

function parseTimestamp(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function recordAt(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function numberAt(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return typeof nested === 'number' && Number.isFinite(nested) ? nested : null;
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function dedupeAlerts(alerts: ModuleVerificationAlert[]) {
  const seen = new Set<string>();
  return alerts.filter((alert) => {
    const key = `${alert.moduleId}:${alert.type}:${alert.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function severityRank(severity: AlertSeverity) {
  switch (severity) {
    case 'CRITICAL': return 4;
    case 'HIGH': return 3;
    case 'MEDIUM': return 2;
    case 'LOW': return 1;
  }
}

function percentile(values: number[], quantile: number) {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1);
  return values[index];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
