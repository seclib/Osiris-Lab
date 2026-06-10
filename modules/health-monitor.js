const http = require('http');
const net = require('net');

const port = Number(process.env.HEALTH_PORT || 4190);
const redisUrl = process.env.REDIS_URL || '';
const targetSpec = process.env.HEALTH_HTTP_TARGETS || '';

function parseTargets() {
  return targetSpec
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [id, url, mode] = item.split('|');
      return {
        id,
        url,
        required: mode !== 'optional',
      };
    })
    .filter((target) => target.id && target.url);
}

async function checkHttp(target) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.HEALTH_TIMEOUT_MS || 2500));

  try {
    const res = await fetch(target.url, { signal: controller.signal, cache: 'no-store' });
    const text = await res.text();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 200) };
    }

    const reportedStatus = body.status || (res.ok ? 'OK' : 'OFFLINE');
    const normalizedStatus = reportedStatus === 'operational' || reportedStatus === 'ok'
      ? 'OK'
      : reportedStatus;

    return {
      id: target.id,
      url: target.url,
      required: target.required,
      ok: res.ok,
      httpStatus: res.status,
      status: normalizedStatus,
      enabled: body.enabled,
      reason: body.reason,
    };
  } catch (error) {
    return {
      id: target.id,
      url: target.url,
      required: target.required,
      ok: false,
      status: 'OFFLINE',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function checkRedis() {
  if (!redisUrl) {
    return Promise.resolve({ id: 'redis', required: false, ok: true, status: 'OFFLINE', reason: 'not_configured' });
  }

  return new Promise((resolve) => {
    const url = new URL(redisUrl);
    const socket = net.createConnection({
      host: url.hostname,
      port: Number(url.port || 6379),
      timeout: 1500,
    });

    let data = '';
    socket.on('connect', () => socket.end('*1\r\n$4\r\nPING\r\n'));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    socket.on('error', (error) => resolve({ id: 'redis', required: true, ok: false, status: 'OFFLINE', reason: error.message }));
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ id: 'redis', required: true, ok: false, status: 'OFFLINE', reason: 'timeout' });
    });
    socket.on('close', () => {
      const ok = data.startsWith('+PONG');
      resolve({ id: 'redis', required: true, ok, status: ok ? 'OK' : 'OFFLINE', reason: ok ? 'pong' : 'bad_response' });
    });
  });
}

async function buildSummary() {
  const targets = parseTargets();
  const checks = await Promise.all([
    checkRedis(),
    ...targets.map(checkHttp),
  ]);

  const requiredFailures = checks.filter((check) => check.required && (!check.ok || check.status === 'OFFLINE'));
  const degraded = checks.some((check) => check.status === 'DEGRADED');

  return {
    service: 'osiris-health',
    status: requiredFailures.length > 0 ? 'OFFLINE' : degraded ? 'DEGRADED' : 'OK',
    checks,
    updatedAt: new Date().toISOString(),
  };
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health' || req.url === '/status') {
    return sendJson(res, 200, await buildSummary());
  }

  if (req.url === '/ready') {
    const summary = await buildSummary();
    return sendJson(res, summary.status === 'OFFLINE' ? 503 : 200, summary);
  }

  return sendJson(res, 404, { error: 'not_found' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[osiris-health] health monitor listening on ${port}`);
});
