import {
  verifyModules,
  type AlertSeverity,
  type ModuleVerificationAlert,
  type ModuleVerificationCheck,
  type ModuleVerificationReport,
  type VerifyModulesOptions,
} from '@/lib/module-verifier';

export type DebugModuleId = 'ais' | 'adsb' | 'earthquakes' | 'weather' | 'shodan';

export type FailureClass =
  | 'CONFIGURATION'
  | 'INFRASTRUCTURE'
  | 'UPSTREAM_PROVIDER'
  | 'DATA_PIPELINE'
  | 'FRESHNESS'
  | 'PERFORMANCE'
  | 'DISABLED'
  | 'STABLE';

export type FixRisk = 'LOW' | 'MEDIUM' | 'HIGH';

export type RankedHypothesis = {
  rank: number;
  classification: FailureClass;
  confidence: number;
  hypothesis: string;
  evidenceRequired: string[];
};

export type FixAction = {
  id: string;
  risk: FixRisk;
  title: string;
  why: string;
  steps: string[];
  validation: string[];
  rollback: string[];
};

export type ModuleDiagnosis = {
  moduleId: DebugModuleId;
  status: 'STABLE' | 'NEEDS_ATTENTION' | 'FAILED' | 'DISABLED';
  primaryClassification: FailureClass;
  severity: AlertSeverity;
  confidence: number;
  evidence: string[];
  hypotheses: RankedHypothesis[];
  fixActions: FixAction[];
  validationLoop: string[];
  rollbackStrategy: string[];
  safetyConstraints: string[];
  rawCheck: ModuleVerificationCheck;
};

export type ModuleDebugReport = {
  status: 'STABLE' | 'DEGRADED' | 'FAILED';
  scope: DebugModuleId[];
  generatedAt: string;
  summary: {
    modulesAnalyzed: number;
    stable: number;
    disabled: number;
    needsAttention: number;
    failed: number;
    criticalAlerts: number;
  };
  failureClassificationModel: FailureClassificationRule[];
  fixGenerationRules: FixGenerationRule[];
  validationLoopDesign: string[];
  rollbackStrategy: string[];
  safetyConstraints: string[];
  diagnoses: ModuleDiagnosis[];
};

export type FailureClassificationRule = {
  classification: FailureClass;
  triggers: string[];
  evidence: string[];
};

export type FixGenerationRule = {
  classification: FailureClass;
  allowedActions: string[];
  blockedActions: string[];
};

const DEBUG_MODULE_IDS = ['ais', 'adsb', 'earthquakes', 'weather', 'shodan'] as const;
const DEBUG_MODULE_SET = new Set<string>(DEBUG_MODULE_IDS);

export const FAILURE_CLASSIFICATION_MODEL: FailureClassificationRule[] = [
  {
    classification: 'CONFIGURATION',
    triggers: ['missing_required_env', 'missing_one_of', 'no_ais_upstream_configured', '401', '403', 'invalid key'],
    evidence: ['module health reason', 'environment variable presence', 'upstream auth response'],
  },
  {
    classification: 'INFRASTRUCTURE',
    triggers: ['api_unreachable', 'timeout', 'ECONNREFUSED', 'ENOTFOUND', 'http_5xx', 'Docker DNS or port mismatch'],
    evidence: ['HTTP status', 'latency', 'container logs', 'docker compose ps', 'internal DNS lookup'],
  },
  {
    classification: 'UPSTREAM_PROVIDER',
    triggers: ['429', 'quota', 'provider unavailable', 'empty_data with valid schema', 'provider degraded'],
    evidence: ['provider HTTP status', 'rate-limit headers', 'provider status page', 'recent successful cache age'],
  },
  {
    classification: 'DATA_PIPELINE',
    triggers: ['schema_invalid', 'invalid_json', 'parser error', 'payload_degraded'],
    evidence: ['response shape diff', 'normalizer logs', 'dead-letter payload sample'],
  },
  {
    classification: 'FRESHNESS',
    triggers: ['data_stale', 'endpoint_timestamp_stale', 'item_timestamp_stale', 'newest_ship_stale'],
    evidence: ['observed timestamp', 'age seconds', 'collector refresh cadence', 'cache TTL'],
  },
  {
    classification: 'PERFORMANCE',
    triggers: ['latency_high', 'slow fan-out', 'cache miss storm'],
    evidence: ['latency p95', 'cache hit rate', 'provider request count', 'CPU/memory saturation'],
  },
  {
    classification: 'DISABLED',
    triggers: ['module disabled by env/json/runtime override'],
    evidence: ['module registry state', 'runtime override', 'MODULE_*_ENABLED env'],
  },
];

export const FIX_GENERATION_RULES: FixGenerationRule[] = [
  {
    classification: 'CONFIGURATION',
    allowedActions: ['surface missing env vars', 'recommend module toggle/env update', 'validate credentials with provider-safe endpoint'],
    blockedActions: ['write secrets to repo', 'print secret values', 'disable auth checks'],
  },
  {
    classification: 'INFRASTRUCTURE',
    allowedActions: ['restart only affected container after operator approval', 'verify Docker DNS/ports', 'inspect health and logs'],
    blockedActions: ['reset volumes', 'recreate all services blindly', 'delete networks'],
  },
  {
    classification: 'UPSTREAM_PROVIDER',
    allowedActions: ['serve cached/stale-safe data', 'back off requests', 'switch to configured fallback provider'],
    blockedActions: ['bypass rate limits', 'rotate identities to evade quotas', 'scrape prohibited sources'],
  },
  {
    classification: 'DATA_PIPELINE',
    allowedActions: ['quarantine invalid payloads', 'tighten schema parser', 'add backward-compatible parser branch'],
    blockedActions: ['silently synthesize fake operational data', 'drop validation permanently'],
  },
  {
    classification: 'FRESHNESS',
    allowedActions: ['restart collector loop after confirmation', 'reduce cache TTL within provider limits', 'mark feed degraded'],
    blockedActions: ['pretend stale data is live', 'increase polling beyond provider terms'],
  },
  {
    classification: 'PERFORMANCE',
    allowedActions: ['increase cache reuse', 'limit bbox/window', 'lower UI update rate', 'add request coalescing'],
    blockedActions: ['remove rate limits', 'increase global fan-out without capacity planning'],
  },
  {
    classification: 'DISABLED',
    allowedActions: ['confirm intended state', 'enable via module API when authorized'],
    blockedActions: ['override env locks', 'enable compliance-sensitive modules without approval'],
  },
];

const MODULE_FIX_CONTEXT: Record<DebugModuleId, {
  env: string[];
  endpoint: string;
  service: string;
  safeProbe: string;
}> = {
  ais: {
    env: ['AIS_API_KEY', 'VESSEL_API_KEY', 'VESSEL_API_URL', 'MODULE_AIS_ENABLED'],
    endpoint: '/api/maritime',
    service: 'osiris-tracking',
    safeProbe: 'curl -sS http://localhost:3000/api/maritime | jq ".freshness,.total_ships"',
  },
  adsb: {
    env: ['OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET', 'MODULE_ADSB_ENABLED'],
    endpoint: '/api/flights',
    service: 'osiris-tracking',
    safeProbe: 'curl -sS http://localhost:3000/api/flights | jq ".total,.timestamp"',
  },
  earthquakes: {
    env: ['MODULE_EARTHQUAKES_ENABLED'],
    endpoint: '/api/earthquakes',
    service: 'osiris-earthquakes',
    safeProbe: 'curl -sS http://localhost:3000/api/earthquakes | jq ".total,.timestamp"',
  },
  weather: {
    env: ['MODULE_WEATHER_ENABLED'],
    endpoint: '/api/weather',
    service: 'osiris',
    safeProbe: 'curl -sS http://localhost:3000/api/weather | jq ".total,.timestamp"',
  },
  shodan: {
    env: ['SHODAN_API_KEY', 'SHODAN_VERIFY_IP', 'MODULE_SHODAN_ENABLED'],
    endpoint: '/api/osint/shodan',
    service: 'osiris-shodan',
    safeProbe: 'curl -sS "http://localhost:3000/api/osint/shodan?ip=1.1.1.1" | jq "{ports, vulns, status, error}"',
  },
};

export async function runModuleDebugging(options: VerifyModulesOptions): Promise<ModuleDebugReport> {
  const report = await verifyModules({
    ...options,
    includeDisabled: true,
  });

  return diagnoseModuleReport(report);
}

export function diagnoseModuleReport(report: ModuleVerificationReport): ModuleDebugReport {
  const diagnoses = report.checks
    .filter((check) => DEBUG_MODULE_SET.has(check.moduleId))
    .map((check) => diagnoseCheck(check as ModuleVerificationCheck & { moduleId: DebugModuleId }, new Date(report.generatedAt)));

  const failed = diagnoses.filter((diagnosis) => diagnosis.status === 'FAILED').length;
  const needsAttention = diagnoses.filter((diagnosis) => diagnosis.status === 'NEEDS_ATTENTION').length;
  const disabled = diagnoses.filter((diagnosis) => diagnosis.status === 'DISABLED').length;
  const stable = diagnoses.filter((diagnosis) => diagnosis.status === 'STABLE').length;
  const criticalAlerts = diagnoses.flatMap((diagnosis) => diagnosis.rawCheck.alerts).filter((alert) => alert.severity === 'CRITICAL').length;

  return {
    status: failed > 0 ? 'FAILED' : needsAttention > 0 ? 'DEGRADED' : 'STABLE',
    scope: [...DEBUG_MODULE_IDS],
    generatedAt: report.generatedAt,
    summary: {
      modulesAnalyzed: diagnoses.length,
      stable,
      disabled,
      needsAttention,
      failed,
      criticalAlerts,
    },
    failureClassificationModel: FAILURE_CLASSIFICATION_MODEL,
    fixGenerationRules: FIX_GENERATION_RULES,
    validationLoopDesign: validationLoopDesign(),
    rollbackStrategy: rollbackStrategy(),
    safetyConstraints: safetyConstraints(),
    diagnoses,
  };
}

function diagnoseCheck(check: ModuleVerificationCheck & { moduleId: DebugModuleId }, now: Date): ModuleDiagnosis {
  const classification = classifyCheck(check);
  const severity = maxSeverity(check.alerts);
  const status = statusFromCheck(check, classification);
  const hypotheses = buildHypotheses(check, classification);
  const evidence = evidenceFromCheck(check);

  return {
    moduleId: check.moduleId,
    status,
    primaryClassification: classification,
    severity,
    confidence: confidenceFor(check, classification),
    evidence,
    hypotheses,
    fixActions: fixActionsFor(check, classification),
    validationLoop: validationLoopFor(check.moduleId),
    rollbackStrategy: rollbackFor(check.moduleId, classification),
    safetyConstraints: safetyConstraints(),
    rawCheck: {
      ...check,
      alerts: check.alerts.map((alert) => ({
        ...alert,
        generatedAt: alert.generatedAt || now.toISOString(),
      })),
    },
  };
}

function classifyCheck(check: ModuleVerificationCheck): FailureClass {
  const text = [
    check.status,
    ...check.errors,
    ...check.warnings,
    ...check.alerts.map((alert) => `${alert.type} ${alert.message}`),
    check.freshness.reason || '',
  ].join(' ').toLowerCase();

  if (check.status === 'DISABLED' || !check.enabled) return 'DISABLED';
  if (check.status === 'OK') return 'STABLE';
  if (matches(text, ['missing_required_env', 'missing_one_of', 'no_ais_upstream_configured', '401', '403', 'invalid key', 'unauthorized'])) return 'CONFIGURATION';
  if (matches(text, ['api_unreachable', 'timeout', 'econnrefused', 'enotfound', 'http_5', 'network', 'fetch failed'])) return 'INFRASTRUCTURE';
  if (matches(text, ['429', 'quota', 'rate limit', 'provider', 'empty_data', 'unavailable'])) return 'UPSTREAM_PROVIDER';
  if (matches(text, ['schema_invalid', 'invalid_json', 'parser', 'payload_degraded', 'response_not_json_object'])) return 'DATA_PIPELINE';
  if (matches(text, ['stale', 'freshness', 'endpoint_timestamp_stale', 'item_timestamp_stale', 'newest_ship_stale'])) return 'FRESHNESS';
  if (matches(text, ['latency_high', 'slow'])) return 'PERFORMANCE';
  return check.status === 'OFFLINE' ? 'INFRASTRUCTURE' : 'DATA_PIPELINE';
}

function statusFromCheck(check: ModuleVerificationCheck, classification: FailureClass): ModuleDiagnosis['status'] {
  if (classification === 'DISABLED') return 'DISABLED';
  if (check.status === 'OFFLINE') return 'FAILED';
  if (classification === 'STABLE' && check.status === 'OK') return 'STABLE';
  return 'NEEDS_ATTENTION';
}

function confidenceFor(check: ModuleVerificationCheck, classification: FailureClass) {
  if (classification === 'STABLE') return 0.99;
  if (classification === 'DISABLED') return 0.95;
  if (check.errors.length > 0 && check.alerts.length > 0) return 0.9;
  if (!check.format.ok || !check.freshness.ok) return 0.85;
  if (check.warnings.length > 0) return 0.75;
  return 0.65;
}

function buildHypotheses(check: ModuleVerificationCheck & { moduleId: DebugModuleId }, primary: FailureClass): RankedHypothesis[] {
  const base = hypothesisFor(check.moduleId, primary, 1);
  const secondary = secondaryClasses(primary, check).map((classification, index) => hypothesisFor(check.moduleId, classification, index + 2));
  return [base, ...secondary].slice(0, 3);
}

function hypothesisFor(moduleId: DebugModuleId, classification: FailureClass, rank: number): RankedHypothesis {
  const context = MODULE_FIX_CONTEXT[moduleId];
  const confidence = Math.max(0.35, 0.95 - ((rank - 1) * 0.2));

  switch (classification) {
    case 'CONFIGURATION':
      return {
        rank,
        classification,
        confidence,
        hypothesis: `${moduleId} is enabled but required runtime configuration or provider credentials are missing/invalid.`,
        evidenceRequired: [`check ${context.env.join(', ')}`, `GET /api/modules/${moduleId}`, `inspect ${context.service} health reason`],
      };
    case 'INFRASTRUCTURE':
      return {
        rank,
        classification,
        confidence,
        hypothesis: `${moduleId} API/service is unreachable or failing through Docker network/port/runtime errors.`,
        evidenceRequired: [`docker compose ps ${context.service}`, `docker compose logs --tail=100 ${context.service}`, `curl internal endpoint ${context.endpoint}`],
      };
    case 'UPSTREAM_PROVIDER':
      return {
        rank,
        classification,
        confidence,
        hypothesis: `${moduleId} upstream provider is unavailable, rate limited, or returning empty data.`,
        evidenceRequired: ['provider HTTP status', 'rate-limit headers', 'latest successful cache timestamp'],
      };
    case 'DATA_PIPELINE':
      return {
        rank,
        classification,
        confidence,
        hypothesis: `${moduleId} response no longer matches OSIRIS parser/schema assumptions.`,
        evidenceRequired: ['raw payload sample', 'schema diff', 'normalizer error logs'],
      };
    case 'FRESHNESS':
      return {
        rank,
        classification,
        confidence,
        hypothesis: `${moduleId} collector/cache is serving stale data beyond module freshness SLO.`,
        evidenceRequired: ['payload timestamp', 'collector refresh loop logs', 'cache TTL and last write time'],
      };
    case 'PERFORMANCE':
      return {
        rank,
        classification,
        confidence,
        hypothesis: `${moduleId} endpoint latency is above deployment SLO due to fan-out, cache misses, or upstream slowness.`,
        evidenceRequired: ['latency p95', 'cache hit rate', 'provider request count', 'CPU/memory metrics'],
      };
    case 'DISABLED':
      return {
        rank,
        classification,
        confidence,
        hypothesis: `${moduleId} is intentionally or accidentally disabled by env/json/runtime state.`,
        evidenceRequired: [`GET /api/modules/${moduleId}`, 'runtime override audit trail', `${context.env.join(', ')} values`],
      };
    case 'STABLE':
      return {
        rank,
        classification,
        confidence: 0.99,
        hypothesis: `${moduleId} is reachable, schema-valid, fresh enough, and within latency envelope.`,
        evidenceRequired: ['latest verifier report', 'three consecutive OK checks for deployment stability'],
      };
  }
}

function secondaryClasses(primary: FailureClass, check: ModuleVerificationCheck): FailureClass[] {
  if (primary === 'CONFIGURATION') return ['INFRASTRUCTURE', 'UPSTREAM_PROVIDER'];
  if (primary === 'INFRASTRUCTURE') return ['CONFIGURATION', 'UPSTREAM_PROVIDER'];
  if (primary === 'UPSTREAM_PROVIDER') return ['FRESHNESS', 'DATA_PIPELINE'];
  if (primary === 'DATA_PIPELINE') return ['UPSTREAM_PROVIDER', 'FRESHNESS'];
  if (primary === 'FRESHNESS') return ['UPSTREAM_PROVIDER', 'PERFORMANCE'];
  if (primary === 'PERFORMANCE') return ['UPSTREAM_PROVIDER', 'INFRASTRUCTURE'];
  if (check.errors.length > 0) return ['DATA_PIPELINE', 'INFRASTRUCTURE'];
  return [];
}

function fixActionsFor(check: ModuleVerificationCheck & { moduleId: DebugModuleId }, classification: FailureClass): FixAction[] {
  const context = MODULE_FIX_CONTEXT[check.moduleId];
  const validation = validationLoopFor(check.moduleId);
  const rollback = rollbackFor(check.moduleId, classification);

  switch (classification) {
    case 'CONFIGURATION':
      return [{
        id: `${check.moduleId}:config-hotfix`,
        risk: 'LOW',
        title: 'Fix module configuration',
        why: 'The verifier detected missing/invalid config or credentials.',
        steps: [
          `Confirm expected state: GET /api/modules/${check.moduleId}`,
          `Set or correct only required env vars: ${context.env.join(', ')}`,
          'Do not log or commit secret values.',
          'Restart only the affected collector/app service after operator approval.',
        ],
        validation,
        rollback,
      }];
    case 'INFRASTRUCTURE':
      return [{
        id: `${check.moduleId}:infra-hotfix`,
        risk: 'MEDIUM',
        title: 'Restore service reachability',
        why: 'The module endpoint is unreachable or throwing runtime errors.',
        steps: [
          `Inspect: docker compose ps ${context.service}`,
          `Inspect logs: docker compose logs --tail=100 ${context.service}`,
          'Check Docker DNS, exposed port, healthcheck, and network membership.',
          'If logs show a transient crash loop, restart only the affected service after approval.',
        ],
        validation,
        rollback,
      }];
    case 'UPSTREAM_PROVIDER':
      return [{
        id: `${check.moduleId}:provider-fallback`,
        risk: 'LOW',
        title: 'Degrade gracefully and use configured fallback/cache',
        why: 'The module is reachable but upstream data is unavailable, rate limited, or empty.',
        steps: [
          'Serve stale-safe cached data with degraded status.',
          'Back off provider polling and respect rate-limit headers.',
          'Use configured fallback provider only if licensing and terms allow.',
          'Open an operator alert instead of increasing request volume blindly.',
        ],
        validation,
        rollback,
      }];
    case 'DATA_PIPELINE':
      return [{
        id: `${check.moduleId}:parser-fix`,
        risk: 'MEDIUM',
        title: 'Patch parser/normalizer safely',
        why: 'The response shape no longer matches expected OSIRIS contract.',
        steps: [
          'Capture a redacted raw payload sample.',
          'Add a backward-compatible parser branch and schema test.',
          'Quarantine invalid records instead of crashing the endpoint.',
          'Return degraded empty data if parser cannot safely normalize.',
        ],
        validation,
        rollback,
      }];
    case 'FRESHNESS':
      return [{
        id: `${check.moduleId}:freshness-recovery`,
        risk: 'LOW',
        title: 'Recover stale collector/cache state',
        why: 'The module is serving data older than its freshness SLO.',
        steps: [
          'Check collector refresh loop and last successful upstream fetch.',
          'Verify Redis/cache TTL and last write timestamp.',
          'Restart only the affected collector if the loop is stuck.',
          'Keep module marked degraded until two fresh samples arrive.',
        ],
        validation,
        rollback,
      }];
    case 'PERFORMANCE':
      return [{
        id: `${check.moduleId}:latency-reduction`,
        risk: 'LOW',
        title: 'Reduce endpoint latency',
        why: 'The module passed functionally but exceeded latency budget.',
        steps: [
          'Increase cache reuse/request coalescing.',
          'Reduce global fan-out and prefer bbox/windowed queries.',
          'Cap UI update frequency and response payload size.',
          'Scale collector only after measuring CPU/memory/network saturation.',
        ],
        validation,
        rollback,
      }];
    case 'DISABLED':
      return [{
        id: `${check.moduleId}:enable-if-required`,
        risk: 'LOW',
        title: 'Confirm disabled state',
        why: 'The module is disabled, so no data will be verified or served.',
        steps: [
          `Check runtime state: GET /api/modules/${check.moduleId}`,
          'If this is unintended, enable with PATCH /api/modules/:id using admin token.',
          'Respect env locks and compliance constraints before enabling.',
        ],
        validation,
        rollback,
      }];
    case 'STABLE':
      return [{
        id: `${check.moduleId}:stability-confirmation`,
        risk: 'LOW',
        title: 'Confirm continued stability',
        why: 'The module currently meets health, schema, freshness, and latency checks.',
        steps: ['Run three verifier checks over one refresh window.', 'Keep existing config unchanged.'],
        validation,
        rollback,
      }];
  }
}

function validationLoopFor(moduleId: DebugModuleId) {
  const context = MODULE_FIX_CONTEXT[moduleId];
  return [
    `Run targeted verifier: GET /api/modules/verify?module=${moduleId}&strict=true`,
    `Run safe probe: ${context.safeProbe}`,
    `Confirm module registry state: GET /api/modules/${moduleId}`,
    'Require 3 consecutive OK verifier results before declaring stable.',
    'Confirm no CRITICAL/HIGH alerts remain in /api/modules/diagnose.',
  ];
}

function rollbackFor(moduleId: DebugModuleId, classification: FailureClass) {
  const context = MODULE_FIX_CONTEXT[moduleId];
  return [
    'Rollback only the smallest changed surface: runtime toggle, env var, parser patch, or affected service.',
    `If a runtime toggle caused regression: DELETE /api/modules/${moduleId}`,
    `If a service restart made things worse: restore previous image/config and restart only ${context.service}.`,
    'Keep last known good cache available while upstream/provider issues recover.',
    classification === 'DATA_PIPELINE'
      ? 'If parser patch fails validation, revert parser change and return degraded empty payload rather than bad data.'
      : 'Do not delete volumes, reset Redis, or recreate all networks as a first response.',
  ];
}

function validationLoopDesign() {
  return [
    'Detect: /api/modules/verify runs after deploy and on schedule.',
    'Classify: /api/modules/diagnose maps verifier evidence to CONFIGURATION/INFRASTRUCTURE/UPSTREAM_PROVIDER/DATA_PIPELINE/FRESHNESS/PERFORMANCE/DISABLED/STABLE.',
    'Generate fix: diagnosis emits non-destructive fixActions with validation and rollback steps.',
    'Validate: rerun targeted strict verifier for the module, then require 3 consecutive OK checks.',
    'Confirm stability: no CRITICAL/HIGH alerts, schema valid, freshness under SLO, latency below warning threshold.',
  ];
}

function rollbackStrategy() {
  return [
    'Prefer runtime override rollback with DELETE /api/modules/:id before touching files or containers.',
    'Rollback parser/config changes by reverting the specific commit or env change, not the whole deployment.',
    'Restart only the affected service after approval; never blanket recreate all containers during diagnosis.',
    'Keep degraded cached responses online while upstream providers recover.',
    'Escalate to manual operator review before destructive actions, secret rotation, or provider account changes.',
  ];
}

function safetyConstraints() {
  return [
    'No destructive commands: no volume deletion, no network pruning, no database reset.',
    'No secret disclosure: never print API key values in reports, logs, or fix output.',
    'No unauthorized provider bypass: do not evade rate limits, rotate identities, or scrape prohibited sources.',
    'No synthetic live OSINT: degraded/empty is allowed; fake aircraft/ships/events are not.',
    'No broad restarts without approval: restart only the affected module/service.',
    'All fixes must be validated with strict verifier checks before stability is confirmed.',
  ];
}

function evidenceFromCheck(check: ModuleVerificationCheck) {
  return [
    `status=${check.status}`,
    `enabled=${check.enabled}`,
    check.httpStatus !== undefined ? `httpStatus=${check.httpStatus}` : '',
    check.latencyMs !== undefined ? `latencyMs=${check.latencyMs}` : '',
    check.freshness.ageSeconds !== undefined && check.freshness.ageSeconds !== null ? `ageSeconds=${check.freshness.ageSeconds}` : '',
    check.format.ok ? 'schema=ok' : `schema=invalid expected=${check.format.expected.join(',')}`,
    ...check.errors.map((error) => `error=${error}`),
    ...check.warnings.map((warning) => `warning=${warning}`),
  ].filter(Boolean);
}

function maxSeverity(alerts: ModuleVerificationAlert[]): AlertSeverity {
  if (alerts.some((alert) => alert.severity === 'CRITICAL')) return 'CRITICAL';
  if (alerts.some((alert) => alert.severity === 'HIGH')) return 'HIGH';
  if (alerts.some((alert) => alert.severity === 'MEDIUM')) return 'MEDIUM';
  return 'LOW';
}

function matches(text: string, needles: string[]) {
  return needles.some((needle) => text.includes(needle.toLowerCase()));
}
