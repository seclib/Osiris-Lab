const http = require('http');
const net = require('net');

const moduleId = process.env.MODULE_ID || 'unknown-module';
const moduleName = process.env.MODULE_NAME || moduleId;
const moduleKind = process.env.MODULE_KIND || 'generic';
const port = Number(process.env.MODULE_PORT || 4100);
const refreshMs = Number(process.env.MODULE_REFRESH_SECONDS || 60) * 1000;
const redisUrl = process.env.REDIS_URL || '';
const probeUrl = process.env.MODULE_PROBE_URL || '';
const runtimeConfigUrl = process.env.MODULE_RUNTIME_CONFIG_URL || '';
const requiredPolicy = (process.env.MODULE_REQUIRED_POLICY || 'degraded').toLowerCase();

let lastProbe = null;
let registryState = null;

function splitEnv(name) {
  return (process.env[name] || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function enabled(value) {
  return !['0', 'false', 'no', 'off', 'disabled'].includes(String(value || '').toLowerCase());
}

function configuredEnabled() {
  return enabled(process.env.MODULE_ENABLED ?? 'true');
}

function currentEnabled() {
  if (registryState && typeof registryState.enabled === 'boolean') return registryState.enabled;
  return configuredEnabled();
}

function moduleConfigUrl() {
  if (!runtimeConfigUrl) return '';
  if (runtimeConfigUrl.includes('{id}')) return runtimeConfigUrl.replace('{id}', encodeURIComponent(moduleId));
  return `${runtimeConfigUrl.replace(/\/$/, '')}/${encodeURIComponent(moduleId)}`;
}

async function syncRuntimeConfig() {
  const url = moduleConfigUrl();
  if (!url) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.MODULE_PROBE_TIMEOUT_MS || 5000));

  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return;
    const body = await res.json();
    if (body && body.module && typeof body.module.enabled === 'boolean') {
      registryState = {
        enabled: body.module.enabled,
        state: body.module.state,
        source: body.module.source,
        checkedAt: new Date().toISOString(),
      };
    }
  } catch {
    // Keep the previous runtime state when the registry is temporarily unavailable.
  } finally {
    clearTimeout(timeout);
  }
}

function buildStatus(extra = {}) {
  const isEnabled = currentEnabled();
  const requiredAll = splitEnv('MODULE_REQUIRED_ALL');
  const requiredAny = splitEnv('MODULE_REQUIRED_ANY');
  const missingAll = requiredAll.filter((name) => !process.env[name]);
  const hasAny = requiredAny.length === 0 || requiredAny.some((name) => Boolean(process.env[name]));

  let status = 'OK';
  let reason = 'module_ready';

  if (!isEnabled) {
    status = 'OFFLINE';
    reason = registryState?.source === 'runtime' ? 'disabled_by_runtime' : 'disabled_by_config';
  } else if (missingAll.length > 0 || !hasAny) {
    status = requiredPolicy === 'offline' ? 'OFFLINE' : 'DEGRADED';
    reason = missingAll.length > 0
      ? `missing_required_env:${missingAll.join(',')}`
      : `missing_one_of:${requiredAny.join(',')}`;
  } else if (lastProbe && !lastProbe.ok) {
    status = 'DEGRADED';
    reason = lastProbe.error || `probe_failed:${lastProbe.status || 'unknown'}`;
  } else if (!probeUrl) {
    reason = 'collector_idle_no_external_probe';
  } else if (lastProbe?.ok) {
    reason = 'probe_ok';
  }

  return {
    moduleId,
    moduleName,
    moduleKind,
    enabled: isEnabled,
    status,
    reason,
    lastSuccess: lastProbe?.ok ? lastProbe.checkedAt : null,
    lastProbe,
    registryState,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

function redisCommand(commands) {
  if (!redisUrl) return Promise.resolve();

  return new Promise((resolve) => {
    const url = new URL(redisUrl);
    const socket = net.createConnection({
      host: url.hostname,
      port: Number(url.port || 6379),
      timeout: 1500,
    });

    socket.on('connect', () => {
      const payload = commands
        .map((parts) => `*${parts.length}\r\n${parts.map((part) => {
          const value = String(part);
          return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
        }).join('')}`)
        .join('');
      socket.end(payload);
    });

    socket.on('error', () => resolve());
    socket.on('timeout', () => {
      socket.destroy();
      resolve();
    });
    socket.on('close', () => resolve());
  });
}

async function publishStatus() {
  const status = buildStatus();
  await redisCommand([
    ['SETEX', `osiris:module:${moduleId}:health`, process.env.MODULE_STATUS_TTL_SECONDS || '120', JSON.stringify(status)],
  ]);
}

async function probeExternalSource() {
  if (!probeUrl || !currentEnabled()) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.MODULE_PROBE_TIMEOUT_MS || 5000));

  try {
    const res = await fetch(probeUrl, { signal: controller.signal, cache: 'no-store' });
    lastProbe = {
      ok: res.ok,
      status: res.status,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    lastProbe = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health' || req.url === '/status') {
    return sendJson(res, 200, buildStatus());
  }

  if (req.url === '/ready') {
    const status = buildStatus();
    const ready = status.enabled ? status.status !== 'OFFLINE' : true;
    return sendJson(res, ready ? 200 : 503, status);
  }

  if (req.url === '/metrics') {
    const status = buildStatus();
    const value = status.status === 'OK' ? 1 : status.status === 'DEGRADED' ? 0.5 : 0;
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    return res.end([
      `osiris_module_health{module="${moduleId}",status="${status.status}"} ${value}`,
      '',
    ].join('\n'));
  }

  return sendJson(res, 404, { error: 'not_found' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[${moduleId}] ${moduleName} health endpoint listening on ${port}`);
});

async function tick() {
  await syncRuntimeConfig();
  await probeExternalSource();
  await publishStatus();
}

tick().catch((error) => console.error(`[${moduleId}] tick failed`, error));
setInterval(() => {
  tick().catch((error) => console.error(`[${moduleId}] tick failed`, error));
}, refreshMs);
