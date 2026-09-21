const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const routes = new Set([
  '/api/health', '/api/auth/me', '/api/auth/signup', '/api/auth/login',
  '/api/auth/logout', '/api/crm-data', '/api/chat-usage', '/api/pipechat-ai'
]);

function routeLabel(rawUrl) {
  try {
    const pathname = new URL(rawUrl, 'http://pipechat.invalid').pathname;
    if (routes.has(pathname)) return pathname;
    return pathname.startsWith('/api/') ? 'other_api' : 'static';
  } catch { return 'unknown'; }
}

function monitorRequest(req, res, write = line => console.log(line)) {
  const requestId = randomUUID();
  const started = performance.now();
  const method = methods.has(req.method) ? req.method : 'OTHER';
  const route = routeLabel(req.url);
  let recorded = false;
  res.setHeader('X-Request-Id', requestId);

  // Construct a closed schema; never spread request, response, or error objects.
  function record(outcome) {
    if (recorded) return;
    recorded = true;
    const entry = {
      event: 'pipechat.request',
      timestamp: new Date().toISOString(),
      requestId, method, route,
      status: outcome === 'finished' ? res.statusCode : null,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      outcome
    };
    try { write(JSON.stringify(entry)); }
    catch { /* A logging failure must not alter a CRM write or its response. */ }
  }

  res.once('finish', () => record('finished'));
  res.once('close', () => record('aborted'));
  return requestId;
}

module.exports = { monitorRequest, routeLabel };
