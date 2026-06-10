import { readFileSync } from 'node:fs';
import net from 'node:net';

export type ModuleState = 'ENABLED' | 'DISABLED';
export type ModuleHealthStatus = 'OK' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN';

export type ModuleDefinition = {
  id: string;
  name: string;
  kind: string;
  description: string;
  envKeys: string[];
  defaultEnabled: boolean;
  endpoint?: string;
  service?: string;
  uiLayerKeys?: string[];
};

export type RuntimeModuleOverride = {
  enabled: boolean;
  updatedAt: string;
  updatedBy?: string;
  reason?: string;
};

export type ResolvedModule = ModuleDefinition & {
  state: ModuleState;
  enabled: boolean;
  defaultEnabledResolved: boolean;
  source: 'runtime' | 'env' | 'json' | 'default';
  locked: boolean;
  runtimeOverride: RuntimeModuleOverride | null;
  health: {
    status: ModuleHealthStatus;
    reason?: string | null;
    raw?: unknown;
  };
};

export type ModulePatch = {
  id: string;
  enabled: boolean;
  updatedBy?: string;
  reason?: string;
};

type RedisReply = string | number | null | RedisReply[];

type JsonModuleConfig = {
  enabled?: boolean;
};

type JsonConfigMap = Record<string, JsonModuleConfig>;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);

export const MODULE_DEFINITIONS = [
  {
    id: 'ais',
    name: 'AIS Maritime Tracking',
    kind: 'maritime',
    description: 'Real-time maritime vessel tracking through AISStream or licensed AIS fallback APIs.',
    envKeys: ['AIS_MODULE', 'MODULE_AIS_ENABLED'],
    defaultEnabled: true,
    endpoint: '/api/maritime',
    service: 'osiris-tracking',
    uiLayerKeys: ['maritime'],
  },
  {
    id: 'adsb',
    name: 'ADS-B Aviation Tracking',
    kind: 'aviation',
    description: 'Real-time aircraft tracking through ADS-B/OpenSky-compatible providers.',
    envKeys: ['ADS_B_MODULE', 'ADSB_MODULE', 'MODULE_ADSB_ENABLED'],
    defaultEnabled: true,
    endpoint: '/api/flights',
    service: 'osiris-tracking',
    uiLayerKeys: ['commercial_flights', 'private_flights', 'private_jets', 'military_flights'],
  },
  {
    id: 'earthquakes',
    name: 'Earthquake Feed',
    kind: 'seismic',
    description: 'USGS seismic event feed.',
    envKeys: ['EARTHQUAKE_MODULE', 'EARTHQUAKES_MODULE', 'MODULE_EARTHQUAKES_ENABLED'],
    defaultEnabled: true,
    endpoint: '/api/earthquakes',
    service: 'osiris-earthquakes',
    uiLayerKeys: ['earthquakes'],
  },
  {
    id: 'wildfires',
    name: 'Wildfire Feed',
    kind: 'fire',
    description: 'NASA FIRMS and EONET fire/volcano event feed.',
    envKeys: ['WILDFIRE_MODULE', 'WILDFIRES_MODULE', 'MODULE_WILDFIRES_ENABLED'],
    defaultEnabled: true,
    endpoint: '/api/fires',
    service: 'osiris-wildfires',
    uiLayerKeys: ['fires'],
  },
  {
    id: 'satellites',
    name: 'Satellite Tracking',
    kind: 'space',
    description: 'Satellite TLE ingestion and propagated position layer.',
    envKeys: ['SATELLITE_MODULE', 'SATELLITES_MODULE', 'MODULE_SATELLITES_ENABLED'],
    defaultEnabled: true,
    endpoint: '/api/satellites',
    service: 'osiris-satellites',
    uiLayerKeys: ['satellites'],
  },
  {
    id: 'shodan',
    name: 'Shodan Enrichment',
    kind: 'cyber',
    description: 'Passive internet exposure metadata enrichment.',
    envKeys: ['SHODAN_MODULE', 'MODULE_SHODAN_ENABLED'],
    defaultEnabled: false,
    endpoint: '/api/osint/shodan',
    service: 'osiris-shodan',
  },
  {
    id: 'intelligence',
    name: 'OSINT Intelligence Layer',
    kind: 'intelligence',
    description: 'Correlation, scoring, anomaly detection, and analyst-grade intelligence findings.',
    envKeys: ['INTELLIGENCE_MODULE', 'MODULE_INTELLIGENCE_ENABLED'],
    defaultEnabled: true,
    endpoint: '/api/intelligence',
    service: 'osiris-intel',
  },
  {
    id: 'cctv',
    name: 'Public Camera Layer',
    kind: 'video',
    description: 'Publicly documented traffic/news camera metadata and external display links.',
    envKeys: ['CCTV_MODULE', 'MODULE_CCTV_ENABLED'],
    defaultEnabled: false,
    endpoint: '/api/cctv',
    uiLayerKeys: ['cctv'],
  },
  {
    id: 'news',
    name: 'News OSINT Feed',
    kind: 'news',
    description: 'RSS-first news intelligence feed.',
    envKeys: ['NEWS_MODULE', 'MODULE_NEWS_ENABLED'],
    defaultEnabled: true,
    endpoint: '/api/news',
    uiLayerKeys: ['news_intel'],
  },
  {
    id: 'weather',
    name: 'Weather Events',
    kind: 'weather',
    description: 'NOAA/NWS and NASA EONET weather event feed.',
    envKeys: ['WEATHER_MODULE', 'MODULE_WEATHER_ENABLED'],
    defaultEnabled: true,
    endpoint: '/api/weather',
    uiLayerKeys: ['weather'],
  },
  {
    id: 'cyber',
    name: 'Cyber Threat Feed',
    kind: 'cyber',
    description: 'CVE, KEV, and public threat metadata feed.',
    envKeys: ['CYBER_MODULE', 'MODULE_CYBER_ENABLED'],
    defaultEnabled: true,
    endpoint: '/api/cyber-threats',
  },
] as const satisfies readonly ModuleDefinition[];

export const MODULE_CONFIG_SCHEMA = {
  env: {
    booleans: ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', 'enabled', 'disabled'],
    examples: {
      AIS_MODULE: 'true',
      ADS_B_MODULE: 'false',
      MODULE_AIS_ENABLED: 'true',
      MODULE_ADSB_ENABLED: 'false',
      MODULE_AIS_LOCKED: 'true',
      OSIRIS_MODULE_ADMIN_TOKEN: 'change-me',
    },
    lockRule: 'Set MODULE_<ID>_LOCKED=true to prevent runtime UI/API overrides for that module.',
  },
  json: {
    envVar: 'OSIRIS_MODULES_JSON',
    fileVar: 'OSIRIS_MODULE_CONFIG',
    examples: [
      '{"modules":{"ais":{"enabled":true},"adsb":{"enabled":false}}}',
      '{"ais":true,"adsb":{"enabled":false},"intelligence":true}',
    ],
  },
  api: {
    list: 'GET /api/modules',
    set: 'PATCH /api/modules {"id":"ais","enabled":true,"reason":"operator toggle"}',
    setOne: 'PATCH /api/modules/ais {"enabled":false}',
    clear: 'DELETE /api/modules/ais',
    verify: 'GET /api/modules/verify?strict=true',
    diagnose: 'GET /api/modules/diagnose?strict=true',
  },
};

const runtimeMemoryStore = globalThis as typeof globalThis & {
  __osirisModuleRuntimeOverrides?: Map<string, RuntimeModuleOverride>;
};

function memoryStore() {
  if (!runtimeMemoryStore.__osirisModuleRuntimeOverrides) {
    runtimeMemoryStore.__osirisModuleRuntimeOverrides = new Map();
  }
  return runtimeMemoryStore.__osirisModuleRuntimeOverrides;
}

export function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return null;
}

export function getModuleDefinition(id: string): ModuleDefinition | null {
  return MODULE_DEFINITIONS.find((definition) => definition.id === normalizeModuleId(id)) || null;
}

export function normalizeModuleId(id: string): string {
  return id.trim().toLowerCase().replace(/_/g, '-').replace(/^ads-b$/, 'adsb');
}

function envValue(definition: ModuleDefinition) {
  for (const key of definition.envKeys) {
    const parsed = parseBoolean(process.env[key]);
    if (parsed !== null) return { enabled: parsed, key };
  }
  return null;
}

function envLocked(definition: ModuleDefinition) {
  if (parseBoolean(process.env.OSIRIS_MODULE_ENV_LOCK) === true) return true;

  const lockKeys = [
    `MODULE_${definition.id.toUpperCase().replace(/-/g, '_')}_LOCKED`,
    `${definition.id.toUpperCase().replace(/-/g, '_')}_MODULE_LOCKED`,
  ];

  return lockKeys.some((key) => parseBoolean(process.env[key]) === true);
}

function normalizeJsonConfig(raw: unknown): JsonConfigMap {
  if (!raw || typeof raw !== 'object') return {};
  const root = raw as Record<string, unknown>;
  const modules = typeof root.modules === 'object' && root.modules !== null
    ? root.modules as Record<string, unknown>
    : root;

  const result: JsonConfigMap = {};
  for (const [key, value] of Object.entries(modules)) {
    const id = normalizeModuleId(key);
    if (typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
      const enabled = parseBoolean(value);
      if (enabled !== null) result[id] = { enabled };
      continue;
    }

    if (value && typeof value === 'object') {
      const enabled = parseBoolean((value as Record<string, unknown>).enabled);
      if (enabled !== null) result[id] = { enabled };
    }
  }
  return result;
}

function readJsonConfig(): JsonConfigMap {
  const sources: string[] = [];
  if (process.env.OSIRIS_MODULES_JSON) sources.push(process.env.OSIRIS_MODULES_JSON);
  if (process.env.OSIRIS_MODULE_CONFIG) {
    try {
      sources.push(readFileSync(process.env.OSIRIS_MODULE_CONFIG, 'utf8'));
    } catch {
      // Invalid/missing optional config file should not prevent startup.
    }
  }

  return sources.reduce<JsonConfigMap>((merged, source) => {
    try {
      return { ...merged, ...normalizeJsonConfig(JSON.parse(source)) };
    } catch {
      return merged;
    }
  }, {});
}

function redisKey(id: string) {
  return `osiris:module:${id}:runtime`;
}

function redisHealthKey(id: string) {
  return `osiris:module:${id}:health`;
}

function encodeRedisCommand(parts: string[]) {
  return `*${parts.length}\r\n${parts.map((part) => {
    const value = String(part);
    return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  }).join('')}`;
}

function parseRedisReply(buffer: string, start = 0): { value: RedisReply; offset: number } {
  const prefix = buffer[start];
  const lineEnd = buffer.indexOf('\r\n', start);
  if (lineEnd === -1) throw new Error('Invalid Redis response');
  const line = buffer.slice(start + 1, lineEnd);
  const bodyStart = lineEnd + 2;

  if (prefix === '+') return { value: line, offset: bodyStart };
  if (prefix === ':') return { value: Number(line), offset: bodyStart };
  if (prefix === '-') throw new Error(line);
  if (prefix === '$') {
    const length = Number(line);
    if (length === -1) return { value: null, offset: bodyStart };
    return {
      value: buffer.slice(bodyStart, bodyStart + length),
      offset: bodyStart + length + 2,
    };
  }
  if (prefix === '*') {
    const count = Number(line);
    if (count === -1) return { value: null, offset: bodyStart };
    const values: RedisReply[] = [];
    let offset = bodyStart;
    for (let i = 0; i < count; i++) {
      const parsed = parseRedisReply(buffer, offset);
      values.push(parsed.value);
      offset = parsed.offset;
    }
    return { value: values, offset };
  }
  throw new Error('Unknown Redis response');
}

async function redisCommand(commands: string[][]): Promise<RedisReply[]> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('Redis not configured');

  const url = new URL(redisUrl);
  const setupCommands: string[][] = [];
  if (url.password) {
    setupCommands.push(url.username ? ['AUTH', decodeURIComponent(url.username), decodeURIComponent(url.password)] : ['AUTH', decodeURIComponent(url.password)]);
  }
  const db = url.pathname.replace('/', '');
  if (db) setupCommands.push(['SELECT', db]);

  const allCommands = [...setupCommands, ...commands];

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection({
      host: url.hostname,
      port: Number(url.port || 6379),
      timeout: Number(process.env.MODULE_REDIS_TIMEOUT_MS || 1500),
    });

    socket.on('connect', () => {
      socket.end(allCommands.map(encodeRedisCommand).join(''));
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Redis timeout'));
    });
    socket.on('close', () => {
      try {
        const buffer = Buffer.concat(chunks).toString('utf8');
        const replies: RedisReply[] = [];
        let offset = 0;
        while (offset < buffer.length) {
          const parsed = parseRedisReply(buffer, offset);
          replies.push(parsed.value);
          offset = parsed.offset;
        }
        resolve(replies.slice(setupCommands.length));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseRuntimeOverride(value: unknown): RuntimeModuleOverride | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<RuntimeModuleOverride>;
    if (typeof parsed.enabled !== 'boolean') return null;
    return {
      enabled: parsed.enabled,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      updatedBy: parsed.updatedBy,
      reason: parsed.reason,
    };
  } catch {
    return null;
  }
}

async function readRuntimeOverrides() {
  const ids = MODULE_DEFINITIONS.map((definition) => definition.id);
  const overrides: Record<string, RuntimeModuleOverride | null> = {};

  if (process.env.REDIS_URL) {
    try {
      const replies = await redisCommand(ids.map((id) => ['GET', redisKey(id)]));
      ids.forEach((id, index) => {
        overrides[id] = parseRuntimeOverride(replies[index]);
      });
      return overrides;
    } catch {
      // Fall back to in-process overrides when Redis is unavailable.
    }
  }

  const store = memoryStore();
  ids.forEach((id) => {
    overrides[id] = store.get(id) || null;
  });
  return overrides;
}

async function readModuleHealth() {
  const ids = MODULE_DEFINITIONS.map((definition) => definition.id);
  const health: Record<string, unknown> = {};
  if (!process.env.REDIS_URL) return health;

  try {
    const replies = await redisCommand(ids.map((id) => ['GET', redisHealthKey(id)]));
    ids.forEach((id, index) => {
      const reply = replies[index];
      if (typeof reply !== 'string') return;
      try {
        health[id] = JSON.parse(reply);
      } catch {
        health[id] = reply;
      }
    });
  } catch {
    return health;
  }
  return health;
}

function resolveDefault(definition: ModuleDefinition, jsonConfig: JsonConfigMap) {
  const fromEnv = envValue(definition);
  if (fromEnv) return { enabled: fromEnv.enabled, source: 'env' as const };

  const fromJson = jsonConfig[definition.id];
  if (fromJson && typeof fromJson.enabled === 'boolean') {
    return { enabled: fromJson.enabled, source: 'json' as const };
  }

  return { enabled: definition.defaultEnabled, source: 'default' as const };
}

function healthStatus(raw: unknown): ResolvedModule['health'] {
  if (!raw || typeof raw !== 'object') return { status: 'UNKNOWN' };
  const record = raw as Record<string, unknown>;
  const status = typeof record.status === 'string' ? record.status.toUpperCase() : 'UNKNOWN';
  const normalized: ModuleHealthStatus = status === 'OK' || status === 'DEGRADED' || status === 'OFFLINE'
    ? status
    : 'UNKNOWN';
  return {
    status: normalized,
    reason: typeof record.reason === 'string' ? record.reason : null,
    raw,
  };
}

export function resolveModule(
  definition: ModuleDefinition,
  runtimeOverride: RuntimeModuleOverride | null,
  rawHealth: unknown,
  jsonConfig = readJsonConfig(),
): ResolvedModule {
  const locked = envLocked(definition);
  const defaultState = resolveDefault(definition, jsonConfig);
  const runtimeApplies = runtimeOverride && !locked;
  const enabled = runtimeApplies ? runtimeOverride.enabled : defaultState.enabled;

  return {
    ...definition,
    enabled,
    state: enabled ? 'ENABLED' : 'DISABLED',
    defaultEnabledResolved: defaultState.enabled,
    source: runtimeApplies ? 'runtime' : defaultState.source,
    locked,
    runtimeOverride,
    health: enabled ? healthStatus(rawHealth) : { status: 'OFFLINE', reason: 'module_disabled' },
  };
}

export async function listModules(): Promise<ResolvedModule[]> {
  const [overrides, health] = await Promise.all([
    readRuntimeOverrides(),
    readModuleHealth(),
  ]);
  const jsonConfig = readJsonConfig();

  return MODULE_DEFINITIONS.map((definition) => resolveModule(
    definition,
    overrides[definition.id] || null,
    health[definition.id],
    jsonConfig,
  ));
}

export async function getModuleState(id: string): Promise<ResolvedModule | null> {
  const normalized = normalizeModuleId(id);
  const definition = getModuleDefinition(normalized);
  if (!definition) return null;
  const modules = await listModules();
  return modules.find((module) => module.id === normalized) || null;
}

export async function isModuleEnabled(id: string): Promise<boolean> {
  const state = await getModuleState(id);
  return state ? state.enabled : true;
}

export async function setModuleRuntimeState(patch: ModulePatch): Promise<ResolvedModule> {
  const id = normalizeModuleId(patch.id);
  const definition = getModuleDefinition(id);
  if (!definition) throw new Error(`Unknown module: ${patch.id}`);
  if (envLocked(definition)) throw new Error(`Module is locked by environment: ${id}`);

  const override: RuntimeModuleOverride = {
    enabled: patch.enabled,
    updatedAt: new Date().toISOString(),
    updatedBy: patch.updatedBy,
    reason: patch.reason,
  };

  if (process.env.REDIS_URL) {
    try {
      await redisCommand([['SET', redisKey(id), JSON.stringify(override)]]);
    } catch {
      memoryStore().set(id, override);
    }
  } else {
    memoryStore().set(id, override);
  }

  const state = await getModuleState(id);
  if (!state) throw new Error(`Unknown module: ${id}`);
  return state;
}

export async function clearModuleRuntimeState(id: string): Promise<ResolvedModule> {
  const normalized = normalizeModuleId(id);
  const definition = getModuleDefinition(normalized);
  if (!definition) throw new Error(`Unknown module: ${id}`);
  if (envLocked(definition)) throw new Error(`Module is locked by environment: ${normalized}`);

  if (process.env.REDIS_URL) {
    try {
      await redisCommand([['DEL', redisKey(normalized)]]);
    } catch {
      memoryStore().delete(normalized);
    }
  } else {
    memoryStore().delete(normalized);
  }

  const state = await getModuleState(normalized);
  if (!state) throw new Error(`Unknown module: ${normalized}`);
  return state;
}

export async function disabledModulePayload(id: string, extra: Record<string, unknown> = {}) {
  const moduleState = await getModuleState(id);
  return {
    ...extra,
    disabled: true,
    module: moduleState || { id, state: 'DISABLED', enabled: false },
    timestamp: new Date().toISOString(),
  };
}
